using System.Text;
using Termilly.Pty;

namespace Termilly.Desktop.Features;

/// <summary>
/// A terminal's shell started before the page was up (<see cref="EarlyAgents"/>): its agent's resume command is typed
/// at its first prompt, as the page would have, and what it prints is kept until the page opens the terminal and takes
/// it over (<see cref="Take"/>), then goes straight to the page. Until then it answers the terminal's queries itself
/// (the page answers them after): its version, so the agent knows the terminal as it does when the page starts it, and
/// where its cursor is and what it is, which a shell waits for as it starts (PowerShell for seconds, unanswered).
/// </summary>
internal sealed class EarlyShell(string command, string versionReply) : IDisposable
{
    /// <summary>The prompt marks shell integration prints (SessionLaunch): where the prompt starts, where input does.</summary>
    private const string PromptStart = "\u001b]133;A";
    private const string InputStart = "\u001b]133;B";

    /// <summary>The queries answered before the page is up, each with its answer.</summary>
    private readonly (string[] Queries, string Reply)[] _answers =
    [
        // XTVERSION (CSI > 0 q, or CSI > q): which terminal this is.
        (["\u001b[>0q", "\u001b[>q"], versionReply),
        // Where the cursor is (CSI 6 n): nothing drawn yet, the top left.
        (["\u001b[6n"], TerminalReplies.CursorAtStart),
        // What the terminal is (CSI c, CSI 0 c).
        (["\u001b[c", "\u001b[0c"], TerminalReplies.DeviceAttributes),
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

    /// <summary>The shell, once it runs: what the command is typed into.</summary>
    public IShellSession? Session { get; set; }

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
            Answer(seen, tail.Length);
        }
        TypeAtPrompt(seen);
    }

    /// <summary>
    /// Answers each query in the output, once for each time it's asked. One that ends in what's new (past
    /// <paramref name="old"/>, the tail kept from before) is new: one wholly in the tail was answered then.
    /// </summary>
    private void Answer(string seen, int old)
    {
        foreach (var (queries, reply) in _answers)
        {
            foreach (var query in queries)
            {
                for (var at = seen.IndexOf(query, StringComparison.Ordinal); at >= 0; at = seen.IndexOf(query, at + 1, StringComparison.Ordinal))
                {
                    if (at + query.Length > old)
                    {
                        Session?.Write(reply);
                    }
                }
            }
        }
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
