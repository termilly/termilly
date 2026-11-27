using System.Text;
using System.Text.RegularExpressions;
using Termilly.Pty;

namespace Termilly.Desktop.Features;

/// <summary>
/// A terminal's shell started before the page was up (<see cref="EarlyAgents"/>): its agent's resume command is typed
/// at its first prompt, as the page would have, and what it prints is kept until the page opens the terminal and takes
/// it over (<see cref="Take"/>), then goes straight to the page. Until then it answers the terminal's queries itself
/// (the page answers them after): its version, so the agent knows the terminal as it does when the page starts it, and
/// where its cursor is (followed from the output) and what it is, which a shell waits for (PowerShell at each prompt,
/// seconds when unanswered, then taking what's typed for the answer).
/// </summary>
/// <param name="columns">The terminal's size, which its cursor wraps at.</param>
/// <param name="answersTerminal">
/// Whether it answers where the cursor is and what the terminal is: not on Windows, whose console host answers those.
/// </param>
internal sealed class EarlyShell(string command, string versionReply, int columns, int rows, bool answersTerminal = true) : IDisposable
{
    /// <summary>The prompt marks shell integration prints (SessionLaunch): where the prompt starts, where input does.</summary>
    private const string PromptStart = "\u001b]133;A";
    private const string InputStart = "\u001b]133;B";

    /// <summary>Where the cursor is, from what the shell printed.</summary>
    private readonly CursorTracker _cursor = new(columns, rows);

    /// <summary>A query answered before the page is up, and its answer as things are when it's asked.</summary>
    private sealed record Answer(string[] Queries, Func<string> Reply);

    private Answer[] Answers =>
    [
        // XTVERSION (CSI > 0 q, or CSI > q): which terminal this is.
        new(["\u001b[>0q", "\u001b[>q"], () => versionReply),
        .. answersTerminal
            ? new Answer[]
            {
                // Where the cursor is (CSI 6 n).
                new(["\u001b[6n"], () => _cursor.Report),
                // What the terminal is (CSI c, CSI 0 c).
                new(["\u001b[c", "\u001b[0c"], () => TerminalReplies.DeviceAttributes),
            }
            : [],
    ];

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

    private IShellSession? _session;
    /// <summary>Answers to queries the shell asked before its session was known, sent once it is.</summary>
    private readonly List<string> _unsent = [];

    /// <summary>The shell, once it runs: what the command is typed into, and the answers go to.</summary>
    public IShellSession? Session
    {
        get => _session;
        set
        {
            lock (_gate)
            {
                // The answers kept go first, before any the reader sends from now on: it waits for the gate.
                foreach (var reply in _unsent)
                {
                    value?.Write(reply);
                }
                _unsent.Clear();
                _session = value;
            }
        }
    }

    /// <summary>Its shell's output: kept for the page, or the page's once it took the shell over.</summary>
    public void Print(string data)
    {
        string seen;
        List<string> replies = [];
        bool taken;
        lock (_gate)
        {
            var old = _tail.Length;
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
                replies = AnswerQueries(seen, old);
            }
        }
        // Written outside the gate: a shell that doesn't read them yet mustn't hold its own output up.
        foreach (var reply in replies)
        {
            Reply(reply);
        }
        TypeAtPrompt(seen);
    }

    /// <summary>
    /// Answers each query in the output, once for each time it's asked, in the order asked, the cursor followed up to
    /// each. One that ends in what's new (past <paramref name="old"/>, the tail kept from before) is new: one wholly in
    /// the tail was answered then. Called under the gate, so output is followed in the order it came.
    /// </summary>
    private List<string> AnswerQueries(string seen, int old)
    {
        var asked = new List<(int End, Answer Answer)>();
        var replies = new List<string>();
        foreach (var answer in Answers)
        {
            foreach (var query in answer.Queries)
            {
                for (var at = seen.IndexOf(query, StringComparison.Ordinal); at >= 0; at = seen.IndexOf(query, at + 1, StringComparison.Ordinal))
                {
                    if (at + query.Length > old)
                    {
                        asked.Add((at + query.Length, answer));
                    }
                }
            }
        }
        var data = seen[old..];
        var followed = 0;
        foreach (var (end, answer) in asked.OrderBy(a => a.End))
        {
            _cursor.Follow(data[followed..(end - old)]);
            followed = end - old;
            replies.Add(answer.Reply());
        }
        _cursor.Follow(data[followed..]);
        return replies;
    }

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
