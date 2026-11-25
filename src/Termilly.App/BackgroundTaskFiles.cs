using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>
/// What a background task's output says now: its file (Claude Code's tasks have one), its last line, and its exit code
/// once it ended.
/// </summary>
internal sealed record TaskReading(string? Path, string? LastLine, int? ExitCode);

/// <summary>Reads how an agent's background task goes (Claude Code's from its output file, Codex's from its rollout).</summary>
internal interface ITaskOutput
{
    /// <summary>
    /// Whether a running task reads as something: a Claude task's file shows up as it starts, so one that never does
    /// never started. A Codex task reads as nothing till it ends.
    /// </summary>
    bool ReadsWhileRunning { get; }

    /// <summary>The task's output so far, or null while there's none to read.</summary>
    TaskReading? Read(string session, string taskId);

    /// <summary>No task of the session is left: what was kept to read its tasks goes.</summary>
    void Forget(string session);
}

/// <summary>A background task's process: the shell an agent started it in, and what that shell runs.</summary>
internal interface ITaskProcesses
{
    /// <summary>
    /// Ends the task whose output goes to <paramref name="outputFile"/>, under the terminal's root process: false when
    /// none is found (it ended already).
    /// </summary>
    bool Stop(int terminalPid, string outputFile);

    /// <summary>
    /// Ends the task that runs <paramref name="command"/> (Codex's: it has no output file), under an agent in the
    /// terminal, started nearest <paramref name="started"/>: false when none is found.
    /// </summary>
    bool StopCommand(int terminalPid, string command, DateTimeOffset started);
}

/// <summary>
/// Claude Code's task output files: &lt;temp&gt;/claude*/&lt;project&gt;/&lt;session&gt;/tasks/&lt;task id&gt;.output, which end
/// with "[exited with code N]" when the task does. Only the end of a file is read.
/// </summary>
internal sealed partial class ClaudeTaskOutput : ITaskOutput
{
    /// <summary>How much of a file's end is read: enough for its last line and its exit.</summary>
    private const int TailBytes = 8 * 1024;
    private const string FolderPattern = "claude*";
    private const string TasksFolder = "tasks";
    private const string Extension = ".output";

    [GeneratedRegex(@"\[exited with code (-?\d+)\]\s*$")]
    private static partial Regex ExitLine();

    private readonly Dictionary<(string, string), string> _found = [];
    private readonly string _tempRoot;

    public ClaudeTaskOutput()
        : this(Path.GetTempPath())
    {
    }

    /// <param name="tempRoot">The folder Claude Code's temp folders are in (a test's own).</param>
    internal ClaudeTaskOutput(string tempRoot) => _tempRoot = tempRoot;

    public bool ReadsWhileRunning => true;

    public void Forget(string session)
    {
        foreach (var key in _found.Keys.Where(k => k.Item1 == session).ToList())
        {
            _found.Remove(key);
        }
    }

    public TaskReading? Read(string session, string taskId)
    {
        if (!_found.TryGetValue((session, taskId), out var path))
        {
            if (Find(session, taskId) is not { } file)
            {
                return null;
            }
            _found[(session, taskId)] = path = file;
        }
        try
        {
            var tail = Tail(path);
            var exit = ExitLine().Match(tail);
            var text = exit.Success ? tail[..exit.Index] : tail;
            var last = text.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);
            return new TaskReading(path, last, exit.Success && int.TryParse(exit.Groups[1].Value, out var code) ? code : null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The task's file in any of Claude's temp folders (per project, per session).</summary>
    private string? Find(string session, string taskId)
    {
        if (session.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || taskId.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        {
            return null;
        }
        try
        {
            return Directory.EnumerateDirectories(_tempRoot, FolderPattern)
                .SelectMany(Directory.EnumerateDirectories)
                .Select(project => Path.Combine(project, session, TasksFolder, taskId + Extension))
                .FirstOrDefault(File.Exists);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private static string Tail(string path)
    {
        using var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        var start = Math.Max(0, file.Length - TailBytes);
        file.Seek(start, SeekOrigin.Begin);
        using var reader = new StreamReader(file);
        return reader.ReadToEnd();
    }
}

/// <summary>
/// Stops a task by its output file: the shell the agent started it in writes it, so the processes that have it open
/// under the terminal are the task's: of them, the ones an agent started (a reader of the file, such as tail -f in
/// the terminal, isn't one) end, with everything they run.
/// </summary>
internal sealed class TaskProcesses : ITaskProcesses
{
    /// <summary>The programs that start tasks: the agents (Claude Code's may run under node).</summary>
    private static readonly string[] AgentPrograms = [AgentKinds.Claude, AgentKinds.Codex, "node"];

    private readonly string[] _starters;

    public TaskProcesses()
        : this(AgentPrograms)
    {
    }

    /// <param name="starters">The programs whose children are tasks (a test's own).</param>
    internal TaskProcesses(string[] starters) => _starters = starters;

    /// <summary>The processes under a terminal, and which of them (or the terminal's own) are agents.</summary>
    private sealed record Tree(Dictionary<int, ProcessEntry> Below, HashSet<int> Agents)
    {
        /// <summary>Whether an agent is above the process in the terminal (a reader the user started there has none).</summary>
        public bool UnderAgent(int pid)
        {
            for (var at = pid; Below.TryGetValue(at, out var process); at = process.ParentId)
            {
                if (Agents.Contains(process.ParentId))
                {
                    return true;
                }
            }
            return false;
        }

        /// <summary>Of these, the ones none of the others is above: a task's own process, not what it runs.</summary>
        public List<int> Topmost(HashSet<int> pids) => [.. pids.Where(pid => !pids.Contains(Below[pid].ParentId))];
    }

    private Tree TreeOf(int terminalPid)
    {
        var all = BusyWatcher.Snapshot();
        var below = ClaudeAgentsPoller.Descendants(all, terminalPid).ToDictionary(p => p.Id);
        // The agent may be the terminal's own program, not only one its shell started.
        var agents = below.Values.Concat(all.Where(p => p.Id == terminalPid))
            .Where(p => _starters.Contains(Path.GetFileNameWithoutExtension(p.Exe), StringComparer.OrdinalIgnoreCase))
            .Select(p => p.Id).ToHashSet();
        return new Tree(below, agents);
    }

    public bool Stop(int terminalPid, string outputFile)
    {
        var tree = TreeOf(terminalPid);
        // The task's: an agent above it (its shell, or what that shell handed the file to), and the topmost of those.
        var holders = FileHolders.Of(outputFile, tree.Below.Keys).Where(tree.UnderAgent).ToHashSet();
        return KillChecked(tree.Topmost(holders), () => FileHolders.Of(outputFile, tree.Below.Keys).ToHashSet());
    }

    public bool StopCommand(int terminalPid, string command, DateTimeOffset started)
    {
        // The hook's command may have been cut short ("…" at its end): its start is what's looked for.
        var wanted = command.TrimEnd('…').Trim();
        if (wanted.Length == 0)
        {
            return false;
        }
        var tree = TreeOf(terminalPid);
        var candidates = tree.Below.Keys.Where(pid => !tree.Agents.Contains(pid) && tree.UnderAgent(pid)).ToList();
        HashSet<int> Running() => [.. ProcessCommandLines.Of(candidates).Where(p => p.Value.Contains(wanted, StringComparison.Ordinal)).Select(p => p.Key)];
        // The same command may run twice (or one that contains it): the one started nearest the task is the task's.
        return Closest(tree.Topmost(Running()), started) is { } task && KillChecked([task], Running);
    }

    /// <summary>
    /// Of the processes, the one that started nearest the time. One alone is the task's whenever it started (a command
    /// waiting for the user's approval starts late); of several, one whose start can't be read is the last pick.
    /// </summary>
    private static int? Closest(List<int> pids, DateTimeOffset started) => pids.Count switch
    {
        0 => null,
        1 => pids[0],
        _ => pids.MinBy(pid => StartOffset(pid, started)),
    };

    /// <summary>How far from the time the process started; the most for one that ended or can't be read.</summary>
    private static TimeSpan StartOffset(int pid, DateTimeOffset started)
    {
        using var process = Open(pid);
        try
        {
            return process is null ? TimeSpan.MaxValue : (new DateTimeOffset(process.StartTime) - started).Duration();
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return TimeSpan.MaxValue;
        }
    }

    /// <summary>
    /// Ends each process and what it runs, if it's still the task's when checked again: held open meanwhile, so one
    /// that ended can't hand its id to another.
    /// </summary>
    private static bool KillChecked(List<int> tasks, Func<HashSet<int>> stillTasks)
    {
        var opened = tasks.Select(Open).OfType<Process>().ToList();
        try
        {
            var still = stillTasks();
            var stopped = false;
            foreach (var process in opened.Where(p => still.Contains(p.Id)))
            {
                stopped |= Kill(process); // each one, not just up to the first that ends
            }
            return stopped;
        }
        finally
        {
            opened.ForEach(p => p.Dispose());
        }
    }

    private static Process? Open(int pid)
    {
        try
        {
            return Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
            return null; // it ended
        }
    }

    private static bool Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
            return true;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}
