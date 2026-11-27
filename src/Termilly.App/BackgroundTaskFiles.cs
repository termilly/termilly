using System.Diagnostics;
using System.Text.RegularExpressions;
using Termilly.Pty.Unix;

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
    /// <param name="olderTaskStarted">
    /// When another, older task (a row still running) started the same command: a process started nearer that time is
    /// that task's, never taken for this one, however close together the two started.
    /// </param>
    bool StopCommand(int terminalPid, string command, DateTimeOffset started, DateTimeOffset? olderTaskStarted = null);
}

/// <summary>
/// Claude Code's task output files: &lt;temp&gt;/claude*/&lt;project&gt;/&lt;session&gt;/tasks/&lt;task id&gt;.output, which end
/// with "[exited with code N]" when the task does, or "[killed]". Only the end of a file is read.
/// </summary>
internal sealed partial class ClaudeTaskOutput : ITaskOutput
{
    /// <summary>How much of a file's end is read: enough for its last line and its exit.</summary>
    private const int TailBytes = 8 * 1024;
    private const string FolderPattern = "claude*";
    private const string TasksFolder = "tasks";
    private const string Extension = ".output";

    /// <summary>
    /// Claude Code's temp folder on macOS: /tmp, not the system's own temp folder (TMPDIR, under /var/folders). Every
    /// user's are there, so only this user's own (claude-&lt;uid&gt;) is looked in: another's can't be read.
    /// </summary>
    private const string MacTempRoot = "/tmp";
    private const string MacFolderPrefix = "claude-";
    /// <summary>
    /// The exit code a killed task counts as: Claude Code writes "[killed]" instead of one, and a shell gives a process
    /// ended by SIGKILL (9) 128 + 9.
    /// </summary>
    internal const int KilledExitCode = 128 + 9;

    /// <summary>
    /// How a task's output ends once it did: with its exit code, or killed (Stop's, or Claude Code's own) on a line of its
    /// own, as output that merely ends in "[killed]" isn't the task's end.
    /// </summary>
    [GeneratedRegex(@"(?:\[exited with code (?<code>-?\d+)\]|(?<=^|\n)\[killed\])\s*$")]
    private static partial Regex ExitLine();

    private readonly Dictionary<(string, string), string> _found = [];
    private readonly string _tempRoot;
    private readonly string _folderPattern;

    public ClaudeTaskOutput()
        : this(OperatingSystem.IsMacOS() ? MacTempRoot : Path.GetTempPath(),
            OperatingSystem.IsMacOS() ? MacFolderPrefix + UnixUser.Id : FolderPattern)
    {
    }

    /// <param name="tempRoot">The folder Claude Code's temp folders are in (a test's own).</param>
    /// <param name="folderPattern">Which of its folders are Claude Code's.</param>
    internal ClaudeTaskOutput(string tempRoot, string folderPattern = FolderPattern) =>
        (_tempRoot, _folderPattern) = (tempRoot, folderPattern);

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
            return new TaskReading(path, last, ExitCodeOf(exit));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>The exit code an output's end gives, a killed task's too; null while it runs.</summary>
    private static int? ExitCodeOf(Match exit)
    {
        if (!exit.Success)
        {
            return null;
        }
        var code = exit.Groups["code"];
        if (!code.Success)
        {
            return KilledExitCode;
        }
        return int.TryParse(code.Value, out var exitCode) ? exitCode : null;
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
            return Directory.EnumerateDirectories(_tempRoot, _folderPattern)
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
        var starters = below.Values.Concat(all.Where(p => p.Id == terminalPid))
            .Where(p => _starters.Contains(NameOf(p), StringComparer.OrdinalIgnoreCase))
            .ToDictionary(p => p.Id, NameOf);
        // A runtime (node) is an agent only with none above it: a `node x.js` the agent runs is a task. An agent by name
        // (claude under the node that launched it) always is.
        var agents = starters
            .Where(s => !Runtimes.Contains(s.Value, StringComparer.OrdinalIgnoreCase) || !HasAbove(below, s.Key, [.. starters.Keys]))
            .Select(s => s.Key).ToHashSet();
        return new Tree(below, agents);
    }

    /// <summary>The programs among the starters that run agents as well as tasks.</summary>
    private static readonly string[] Runtimes = ["node"];

    private static string NameOf(ProcessEntry process) => Path.GetFileNameWithoutExtension(process.Exe);

    /// <summary>Whether one of <paramref name="those"/> is above the process, within the terminal.</summary>
    private static bool HasAbove(Dictionary<int, ProcessEntry> below, int pid, HashSet<int> those)
    {
        for (var at = pid; below.TryGetValue(at, out var process); at = process.ParentId)
        {
            if (those.Contains(process.ParentId))
            {
                return true;
            }
        }
        return false;
    }

    public bool Stop(int terminalPid, string outputFile)
    {
        var tree = TreeOf(terminalPid);
        // The task's: an agent above it (its shell, or what that shell handed the file to), and the topmost of those.
        var holders = FileHolders.Of(outputFile, tree.Below.Keys).Where(tree.UnderAgent).ToHashSet();
        return KillChecked(tree.Topmost(holders), () => FileHolders.Of(outputFile, tree.Below.Keys).ToHashSet());
    }

    public bool StopCommand(int terminalPid, string command, DateTimeOffset started, DateTimeOffset? olderTaskStarted = null)
    {
        // The hook's command may have been cut short ("…" at its end): its start is what's looked for.
        var cut = command.TrimEnd().EndsWith('…');
        var wanted = command.TrimEnd().TrimEnd('…').Trim().Replace("\r\n", "\n", StringComparison.Ordinal);
        if (wanted.Length == 0)
        {
            return false;
        }
        var tree = TreeOf(terminalPid);
        var candidates = tree.Below.Keys.Where(pid => !tree.Agents.Contains(pid) && tree.UnderAgent(pid)).ToList();
        HashSet<int> Running() => [.. ProcessCommandLines.Of(candidates).Where(p => Holds(Lines(p.Value), wanted, whole: !cut)).Select(p => p.Key)];
        // The same command may run twice (or one that contains it): the one started nearest the task is the task's. One
        // started since the task first, then one bash ran in its shell's place (an older shell with the same text is
        // another task's), and an older one only when there's nothing else.
        var running = tree.Topmost(Running());
        if (olderTaskStarted is { } older)
        {
            // Each process is the task's it started nearest: one nearer the older task is that one's (this task's own
            // may have just ended, its row not yet updated).
            running = [.. running.Where(pid => StartOffset(pid, started) < StartOffset(pid, older))];
        }
        var recent = running.Where(pid => StartedSince(pid, started)).ToList();
        if (recent.Count > 0)
        {
            return Closest(recent, started) is { } task && KillChecked([task], Running);
        }
        if (!cut && ShellLastCommand.Of(wanted) is { } last && StopExeced(tree, candidates, last, started))
        {
            return true;
        }
        return Closest(running, started) is { } earlier && KillChecked([earlier], Running);
    }

    /// <summary>
    /// bash -c runs the last command in its own place: its process then shows that command's words alone. Only the
    /// agent's own children count (where its shell was), started since the task (an older one running the same words is
    /// another's).
    /// </summary>
    private static bool StopExeced(Tree tree, List<int> candidates, string last, DateTimeOffset started)
    {
        var children = candidates.Where(pid => tree.Agents.Contains(tree.Below[pid].ParentId) && StartedSince(pid, started)).ToList();
        HashSet<int> Execed() => [.. ProcessCommandLines.Of(children).Where(p => string.Equals(p.Value.Trim(), last, StringComparison.Ordinal)).Select(p => p.Key)];
        return Closest([.. Execed()], started) is { } execed && KillChecked([execed], Execed);
    }

    /// <summary>How much earlier than the task's time its process may have started (the hook's clock, the agent's start).</summary>
    private static readonly TimeSpan StartSlack = TimeSpan.FromSeconds(2);

    /// <summary>Whether the process started at the task's time or after it; not one that ended or can't be read.</summary>
    private static bool StartedSince(int pid, DateTimeOffset started)
    {
        using var process = Open(pid);
        try
        {
            return process is not null && new DateTimeOffset(process.StartTime) >= started - StartSlack;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception or NotSupportedException)
        {
            return false;
        }
    }

    /// <summary>A command line with its line breaks as the hook writes them (\n).</summary>
    private static string Lines(string commandLine) => commandLine.Replace("\r\n", "\n", StringComparison.Ordinal);

    /// <summary>
    /// Whether a process's command line holds the command: as it was, or as the agent quoted it for its shell (Windows'
    /// "… \"x\" …", sh -c '… '\''x'\'' …'). Exact, so a command differing only in its spacing or quoting is never taken
    /// for it. It starts where a word does (<c>npm test</c> isn't in <c>pnpm test</c>), and a whole command (not cut
    /// short) ends where one does (<c>sleep 60</c> isn't in <c>sleep 600</c>).
    /// </summary>
    internal static bool Holds(string commandLine, string command, bool whole = true) =>
        new[] { command, WindowsQuoted(command, whole), command.Replace("'", "'\\''", StringComparison.Ordinal) }
            .Any(form => Finds(commandLine, form, whole));

    /// <summary>
    /// The command as Windows quotes it inside a quoted argument: each " escaped, the backslashes just before it doubled,
    /// and those at its end too when the argument's closing quote follows (a whole command, last in the argument).
    /// </summary>
    private static string WindowsQuoted(string command, bool atEnd)
    {
        var quoted = new System.Text.StringBuilder();
        var backslashes = 0;
        foreach (var c in command)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            quoted.Append('\\', c == '"' ? (backslashes * 2) + 1 : backslashes).Append(c);
            backslashes = 0;
        }
        return quoted.Append('\\', atEnd ? backslashes * 2 : backslashes).ToString();
    }

    /// <summary>
    /// Whether <paramref name="text"/> holds <paramref name="part"/>, starting where a word does, and ending where one
    /// does when it's whole.
    /// </summary>
    private static bool Finds(string text, string part, bool whole)
    {
        for (var at = text.IndexOf(part, StringComparison.Ordinal); at >= 0; at = text.IndexOf(part, at + 1, StringComparison.Ordinal))
        {
            var end = at + part.Length;
            var starts = at == 0 || !Continues(part[0]) || !Continues(text[at - 1]);
            var ends = !whole || end == text.Length || !Continues(part[^1]) || !Continues(text[end]);
            if (starts && ends)
            {
                return true;
            }
        }
        return false;
    }

    /// <summary>What ends a shell word: a space, or a separator, redirection, closing bracket or quote.</summary>
    private const string WordEnds = ";&|)<>\"'`";

    /// <summary>Whether the character is part of a shell word (<c>60</c>, <c>60.5</c>, <c>-n</c>), not where one ends.</summary>
    private static bool Continues(char c) => !char.IsWhiteSpace(c) && !WordEnds.Contains(c, StringComparison.Ordinal);

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
