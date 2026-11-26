using System.Text;
using System.Text.RegularExpressions;
using Termilly.Pty;

namespace Termilly.Desktop.Features;

/// <summary>
/// A terminal's shell started before the page was up (<see cref="EarlyAgents"/>): its agent's resume command is typed
/// at its first prompt, as the page would have, and what it prints is kept until the page opens the terminal and takes
/// it over (<see cref="Take"/>), then goes straight to the page. Until then it answers the terminal's queries itself
/// (the page answers them after): its version, so the agent knows the terminal as it does when the page starts it, and
/// where its cursor is and what it is, which a shell waits for as it starts (PowerShell for seconds, unanswered).
/// </summary>
/// <param name="answersTerminal">
/// Whether it answers where the cursor is and what the terminal is: not on Windows, whose console host answers those.
/// </param>
internal sealed partial class EarlyShell(string command, string versionReply, bool answersTerminal = true) : IDisposable
{
    /// <summary>The prompt marks shell integration prints (SessionLaunch): where the prompt starts, where input does.</summary>
    private const string PromptStart = "\u001b]133;A";
    private const string InputStart = "\u001b]133;B";

    /// <summary>
    /// A query answered before the page is up, its answer, and whether it's answered only while nothing is drawn (the
    /// cursor's place is known then: the top left; after, the page answers once it's up).
    /// </summary>
    private sealed record Answer(string[] Queries, string Reply, bool BeforeDrawing = false);

    private readonly Answer[] _answers =
    [
        // XTVERSION (CSI > 0 q, or CSI > q): which terminal this is.
        new(["\u001b[>0q", "\u001b[>q"], versionReply),
        .. answersTerminal
            ? new Answer[]
            {
                // Where the cursor is (CSI 6 n): PowerShell asks as it starts, before drawing anything.
                new(["\u001b[6n"], TerminalReplies.CursorAtStart, BeforeDrawing: true),
                // What the terminal is (CSI c, CSI 0 c).
                new(["\u001b[c", "\u001b[0c"], TerminalReplies.DeviceAttributes),
            }
            : [],
    ];

    /// <summary>An escape sequence (CSI or OSC), which draws nothing.</summary>
    [GeneratedRegex(@"\u001b(\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(\u0007|\u001b\\)?|.)")]
    private static partial Regex EscapeSequence();
    /// <summary>The end of one chunk of output kept with the next, so a mark split between the two is still seen.</summary>
    private const int TailLength = 8;

    private readonly Lock _gate = new();
    private readonly OutputRing _missed = new();
    private Action<string>? _output;
    private Action<int>? _exited;
    private int? _exitCode;
    private string _tail = "";
    private bool _typed;
    private Timer? _typing;
    private Timer? _fallback;
    /// <summary>What reached the page about the shell meanwhile (its agent's reports), told once it takes the shell over.</summary>
    private readonly List<Action> _kept = [];

    /// <summary>Whether the shell has drawn anything yet (text, not escape sequences).</summary>
    private bool _drawn;
    private IShellSession? _session;
    /// <summary>Answers to queries the shell asked before its session was known, sent once it is.</summary>
    private readonly List<string> _unsent = [];

    /// <summary>The shell, once it runs: what the command is typed into, and the answers go to.</summary>
    public IShellSession? Session
    {
        get => _session;
        set
        {
            string[] unsent;
            lock (_gate)
            {
                _session = value;
                unsent = [.. _unsent];
                _unsent.Clear();
            }
            foreach (var reply in unsent)
            {
                value?.Write(reply);
            }
        }
    }

    /// <summary>Its shell's output: kept for the page, or the page's once it took the shell over.</summary>
    public void Print(string data)
    {
        string seen;
        string tail;
        bool taken;
        lock (_gate)
        {
            tail = _tail;
            seen = _tail + data;
            _tail = seen[^Math.Min(TailLength, seen.Length)..];
            taken = _output is not null;
            if (taken)
            {
                _output!(data);
            }
            else
            {
                _missed.Add(data);
            }
        }
        if (!taken)
        {
            AnswerQueries(seen, tail.Length);
        }
        TypeAtPrompt(seen);
    }

    /// <summary>
    /// Answers each query in the output, once for each time it's asked, in the order asked. One that ends in what's new
    /// (past <paramref name="old"/>, the tail kept from before) is new: one wholly in the tail was answered then.
    /// </summary>
    private void AnswerQueries(string seen, int old)
    {
        var asked = new List<(int At, Answer Answer)>();
        foreach (var answer in _answers)
        {
            foreach (var query in answer.Queries)
            {
                for (var at = seen.IndexOf(query, StringComparison.Ordinal); at >= 0; at = seen.IndexOf(query, at + 1, StringComparison.Ordinal))
                {
                    if (at + query.Length > old)
                    {
                        asked.Add((at, answer));
                    }
                }
            }
        }
        foreach (var (at, answer) in asked.OrderBy(a => a.At))
        {
            if (!answer.BeforeDrawing || !DrawnBefore(seen, at, old))
            {
                Reply(answer.Reply);
            }
        }
        lock (_gate)
        {
            _drawn |= Draws(seen[Math.Min(old, seen.Length)..]);
        }
    }

    /// <summary>Whether the shell had drawn anything before the query at <paramref name="at"/>.</summary>
    private bool DrawnBefore(string seen, int at, int old)
    {
        lock (_gate)
        {
            return _drawn || Draws(seen[Math.Min(old, at)..at]);
        }
    }

    /// <summary>Whether the output draws text: anything but escape sequences and spacing.</summary>
    private static bool Draws(string output) => EscapeSequence().Replace(output, "").Any(c => !char.IsWhiteSpace(c) && !char.IsControl(c));

    /// <summary>Answers the shell, or keeps the answer until its session is known.</summary>
    private void Reply(string reply)
    {
        IShellSession? session;
        lock (_gate)
        {
            session = _session;
            if (session is null)
            {
                _unsent.Add(reply);
                return;
            }
        }
        session.Write(reply);
    }

    /// <summary>
    /// Keeps something to tell the page about the shell (its agent's report) until the page takes it over, which would
    /// drop it before: false once it has, and it's to be told now.
    /// </summary>
    public bool Keep(Action tell)
    {
        lock (_gate)
        {
            if (_output is not null)
            {
                return false;
            }
            _kept.Add(tell);
            return true;
        }
    }

    /// <summary>The shell ended: the page hears it once it takes the shell over (at once if it has).</summary>
    public void Exited(int code)
    {
        Action<int>? exited;
        lock (_gate)
        {
            exited = _exited;
            _exitCode = code;
        }
        exited?.Invoke(code);
        Dispose();
    }

    /// <summary>
    /// The page opened the terminal: what the shell printed so far goes to <paramref name="replay"/> (not news: the page
    /// doesn't answer or announce it), the rest to <paramref name="output"/>, and its end to <paramref name="exited"/>.
    /// </summary>
    public void Take(Action<string> output, Action<string> replay, Action<int> exited)
    {
        int? code;
        // In one step: a report that comes meanwhile waits for the gate, so it's told after those kept, never before.
        lock (_gate)
        {
            if (_missed.Text() is { Length: > 0 } missed)
            {
                replay(missed);
            }
            foreach (var tell in _kept)
            {
                tell();
            }
            _kept.Clear();
            _output = output;
            _exited = exited;
            code = _exitCode;
        }
        if (code is { } ended)
        {
            exited(ended);
        }
    }

    /// <summary>Types the command once, a moment after the shell's first prompt mark (when it reads input).</summary>
    private void TypeAtPrompt(string seen)
    {
        var delay = seen.Contains(InputStart, StringComparison.Ordinal) ? PromptTiming.AtInputMs
            : seen.Contains(PromptStart, StringComparison.Ordinal) ? PromptTiming.AtPromptMs : (int?)null;
        if (delay is { } wait)
        {
            TypeAfter(wait);
        }
    }

    /// <summary>A shell that marks no prompt gets the command after a while anyway, as the page does.</summary>
    public void TypeWithoutMarks()
    {
        lock (_gate)
        {
            _fallback ??= new Timer(_ => Type(), null, PromptTiming.WithoutMarksMs, Timeout.Infinite);
        }
    }

    private void TypeAfter(int milliseconds)
    {
        lock (_gate)
        {
            _typing ??= new Timer(_ => Type(), null, milliseconds, Timeout.Infinite);
        }
    }

    /// <summary>Types the command, once: at the prompt or after the wait without marks, whichever comes first.</summary>
    private void Type()
    {
        lock (_gate)
        {
            if (_typed)
            {
                return;
            }
            _typed = true;
        }
        Session?.Write($"{command}\r");
    }

    public void Dispose()
    {
        _typing?.Dispose();
        _fallback?.Dispose();
    }
}
