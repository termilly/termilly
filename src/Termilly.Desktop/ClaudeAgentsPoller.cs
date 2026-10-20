using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A Claude Code session as `claude agents --json` lists it.</summary>
internal sealed record ClaudeAgent(int Pid, string SessionId, string Status, string? WaitingFor);

/// <summary>
/// The fallback for Claude Code sessions Termilly's hooks don't reach: started by full path, from a terminal opened
/// before agent integration was on, and so on. While a terminal has a claude.exe that no hook has reported from, it
/// asks `claude agents --json` every couple of seconds (about 0.3 s of work) and matches each session's process to
/// the terminal it runs in. It doesn't run at all while there's no such claude.
/// </summary>
internal sealed class ClaudeAgentsPoller : IDisposable
{
    private const string ClaudeExe = AgentExecutables.Claude;
    /// <summary>The statuses `claude agents` reports.</summary>
    private static class Statuses
    {
        public const string Busy = "busy";
        public const string Waiting = "waiting";
        public const string Idle = "idle";
    }

    /// <summary>The fields of `claude agents --json` that are read.</summary>
    private static class Fields
    {
        public const string Pid = "pid";
        public const string SessionId = "sessionId";
        public const string Status = "status";
        public const string WaitingFor = "waitingFor";
    }

    private static readonly string[] ListArguments = ["agents", "--json"];
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);
    /// <summary>Where Claude Code's native installer puts it, in the profile.</summary>
    private static readonly string NativeInstall = Path.Combine(".local", "bin");

    private readonly Func<IReadOnlyDictionary<string, int>> _roots;
    private readonly Action<string, string, string?, string> _changed;
    private readonly string _claude;
    private readonly Timer _timer;
    /// <summary>Terminals whose claude reports through hooks: terminal id → its session.</summary>
    private readonly Dictionary<string, string> _hooked = new();
    /// <summary>What was last reported for a terminal: its session and state.</summary>
    private readonly Dictionary<string, (string Session, string State)> _reported = new();
    private readonly Lock _lock = new();
    private int _ticking;

    /// <param name="roots">The terminals: id → the pseudo console's root process id.</param>
    /// <param name="changed">Called on a pool thread with a terminal's id, its agent state, a message and the session id.</param>
    /// <summary>How long `claude agents` may take before this tick gives up on it.</summary>
    private static readonly TimeSpan ListTimeout = TimeSpan.FromSeconds(5);

    private readonly IProcessRunner _runner;

    public ClaudeAgentsPoller(IProcessRunner runner, Func<IReadOnlyDictionary<string, int>> roots, Action<string, string, string?, string> changed, string claude)
    {
        _runner = runner;
        _roots = roots;
        _changed = changed;
        _claude = claude;
        _timer = new Timer(_ => Tick(), null, Interval, Interval);
    }

    /// <summary>The claude (claude.exe on Windows) to ask, or null when Claude Code isn't installed where Termilly can find it.</summary>
    public static string? FindClaude()
    {
        var onPath = (Environment.GetEnvironmentVariable(SystemVariables.Path) ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(dir => Path.Combine(dir, AppPaths.Exe(ClaudeExe)))
            .Where(path => !path.StartsWith(AgentHooks.AgentDirectory, StringComparison.OrdinalIgnoreCase))
            .FirstOrDefault(File.Exists);
        var native = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), NativeInstall, AppPaths.Exe(ClaudeExe));
        return onPath ?? (File.Exists(native) ? native : null);
    }

    /// <summary>A hook reported from this terminal: its claude needs no polling.</summary>
    public void Hooked(string terminal, string? session, bool ended)
    {
        lock (_lock)
        {
            if (ended)
            {
                _hooked.Remove(terminal);
            }
            else
            {
                _hooked[terminal] = session ?? "";
            }
        }
    }

    public void Dispose() => _timer.Dispose();

    private void Tick()
    {
        if (Interlocked.Exchange(ref _ticking, 1) == 1)
        {
            return;
        }
        try
        {
            var roots = _roots();
            var withClaude = TerminalsWithClaude(roots);
            var hookedSessions = LeaveOutHooked(withClaude);
            var agents = withClaude.Count > 0 ? ListAgents() : [];
            var seen = Report(Match(withClaude, agents.Where(a => !hookedSessions.Contains(a.SessionId))));
            ReportGone(seen, roots);
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException or IOException or JsonException)
        {
            // Claude Code missing, slow or changed: skip this look.
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    /// <summary>The terminals with a claude among their processes, and those processes.</summary>
    private static Dictionary<string, HashSet<int>> TerminalsWithClaude(IReadOnlyDictionary<string, int> roots)
    {
        var snapshot = roots.Count > 0 ? BusyWatcher.Snapshot() : [];
        var claude = AppPaths.Exe(ClaudeExe);
        return roots
            .Select(r => (Terminal: r.Key, Processes: Descendants(snapshot, r.Value)))
            .Where(t => t.Processes.Any(p => p.Exe.Equals(claude, StringComparison.OrdinalIgnoreCase)))
            .ToDictionary(t => t.Terminal, t => t.Processes.Select(p => p.Id).ToHashSet());
    }

    /// <summary>
    /// Takes the terminals whose Claude Code reports through hooks out of <paramref name="withClaude"/>; returns the
    /// sessions those hooks belong to. A claude that ended without saying so (killed) stops counting as hooked.
    /// </summary>
    private HashSet<string> LeaveOutHooked(Dictionary<string, HashSet<int>> withClaude)
    {
        lock (_lock)
        {
            foreach (var gone in _hooked.Keys.Where(t => !withClaude.ContainsKey(t)).ToList())
            {
                _hooked.Remove(gone);
            }
            foreach (var terminal in _hooked.Keys)
            {
                withClaude.Remove(terminal);
            }
            return _hooked.Values.ToHashSet();
        }
    }

    /// <summary>Reports each terminal's agent when its state changed; returns the terminals that have one.</summary>
    private HashSet<string> Report(IEnumerable<(string Terminal, ClaudeAgent Agent)> matched)
    {
        var seen = new HashSet<string>();
        foreach (var (terminal, agent) in matched)
        {
            seen.Add(terminal);
            _reported.TryGetValue(terminal, out var before);
            var state = NextState(before.Session == agent.SessionId ? before.State : null, agent.Status);
            if (state is not null && (before.Session != agent.SessionId || before.State != state))
            {
                _reported[terminal] = (agent.SessionId, state);
                _changed(terminal, state, agent.WaitingFor, agent.SessionId);
            }
        }
        return seen;
    }

    /// <summary>A terminal whose agent went away: it exited (unless the terminal itself is gone).</summary>
    private void ReportGone(HashSet<string> seen, IReadOnlyDictionary<string, int> roots)
    {
        foreach (var (terminal, last) in _reported.Where(r => !seen.Contains(r.Key)).ToList())
        {
            _reported.Remove(terminal);
            if (roots.ContainsKey(terminal))
            {
                _changed(terminal, AgentStates.Exited, null, last.Session);
            }
        }
    }

    /// <summary>
    /// The agent state for a status: busy is working, waiting needs the user, and idle after working is done (idle
    /// otherwise). Null for a status this version doesn't know.
    /// </summary>
    public static string? NextState(string? before, string status) => status switch
    {
        Statuses.Busy => AgentStates.Working,
        Statuses.Waiting => AgentStates.NeedsInput,
        Statuses.Idle => before is AgentStates.Working or AgentStates.NeedsInput or AgentStates.Done ? AgentStates.Done : AgentStates.Idle,
        _ => null,
    };

    /// <summary>Which terminal each session runs in: the one whose processes include the session's.</summary>
    public static IEnumerable<(string Terminal, ClaudeAgent Agent)> Match(IReadOnlyDictionary<string, HashSet<int>> terminals, IEnumerable<ClaudeAgent> agents)
    {
        foreach (var agent in agents)
        {
            foreach (var (terminal, pids) in terminals)
            {
                if (pids.Contains(agent.Pid))
                {
                    yield return (terminal, agent);
                    break;
                }
            }
        }
    }

    /// <summary>Every process below the root, however deep (ids reused into a loop are cut off).</summary>
    public static List<ProcessEntry> Descendants(IReadOnlyList<ProcessEntry> all, int rootPid)
    {
        var children = all.ToLookup(p => p.ParentId);
        var found = new List<ProcessEntry>();
        var seen = new HashSet<int> { rootPid };
        var stack = new Stack<ProcessEntry>(children[rootPid]);
        while (stack.Count > 0)
        {
            var process = stack.Pop();
            if (!seen.Add(process.Id))
            {
                continue;
            }
            found.Add(process);
            foreach (var child in children[process.Id])
            {
                stack.Push(child);
            }
        }
        return found;
    }

    /// <summary>Reads `claude agents --json`; sessions without a pid or id are skipped.</summary>
    public static List<ClaudeAgent> ParseAgents(string json)
    {
        using var doc = JsonDocument.Parse(json);
        var agents = new List<ClaudeAgent>();
        if (doc.RootElement.ValueKind != JsonValueKind.Array)
        {
            return agents;
        }
        foreach (var item in doc.RootElement.EnumerateArray())
        {
            if (item.ValueKind == JsonValueKind.Object &&
                item.TryGetProperty(Fields.Pid, out var pid) && pid.TryGetInt32(out var id) &&
                Text(item, Fields.SessionId) is { } session && Text(item, Fields.Status) is { } status)
            {
                agents.Add(new ClaudeAgent(id, session, status, Text(item, Fields.WaitingFor)));
            }
        }
        return agents;
    }

    private static string? Text(JsonElement item, string name) =>
        item.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private List<ClaudeAgent> ListAgents()
    {
        try
        {
            var result = _runner.Run(new ProcessRequest(_claude, ListArguments) { Timeout = ListTimeout });
            return result.Succeeded ? ParseAgents(result.Text) : [];
        }
        catch (IOException)
        {
            return []; // gone, or too slow: next tick
        }
    }
}
