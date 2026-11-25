using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>What a background task's output file says now: where it is, its last line, and its exit code once it ended.</summary>
internal sealed record TaskReading(string Path, string? LastLine, int? ExitCode);

/// <summary>Reads a background task's output file (Claude Code writes one per task, under the temp folder).</summary>
internal interface ITaskOutput
{
    /// <summary>The task's output so far, or null while its file isn't found.</summary>
    TaskReading? Read(string session, string taskId);
}

/// <summary>A background task's shell: its process, and when it started (so a reused id isn't mistaken for it).</summary>
internal sealed record TaskProcess(int Pid, DateTime Started);

/// <summary>A background task's process: the shell an agent started it in, and what that shell runs.</summary>
internal interface ITaskProcesses
{
    /// <summary>
    /// The shell of a task that started at <paramref name="startedAt"/> under the terminal's root process: the agent's
    /// newest one not <paramref name="taken"/> by another task. Null when none is found.
    /// </summary>
    TaskProcess? Find(int terminalPid, DateTime startedAt, IReadOnlySet<int> taken);

    /// <summary>Ends the shell and what it runs, if it's still that process; false when it isn't (it ended already).</summary>
    bool Stop(TaskProcess process);
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
/// Finds and stops a task's shell. The shells agents start carry no command line here, so a task's is the newest the
/// agent started around when the task did, and not another task's.
/// </summary>
internal sealed class TaskProcesses : ITaskProcesses
{
    /// <summary>The shells agents run commands in.</summary>
    private static readonly string[] Shells = ["bash", "sh", "zsh", "fish", "powershell", "pwsh", "cmd"];
    /// <summary>The programs that start them: the agents (Claude Code's may run under node).</summary>
    private static readonly string[] Agents = [AgentKinds.Claude, AgentKinds.Codex, "node"];
    /// <summary>How far from the task's start its shell may have started (the hook comes just after it).</summary>
    private static readonly TimeSpan Around = TimeSpan.FromSeconds(5);

    public TaskProcess? Find(int terminalPid, DateTime startedAt, IReadOnlySet<int> taken)
    {
        var below = ClaudeAgentsPoller.Descendants(BusyWatcher.Snapshot(), terminalPid);
        var agents = below.Where(p => Named(p, Agents)).Select(p => p.Id).ToHashSet();
        return below.Where(p => agents.Contains(p.ParentId) && Named(p, Shells) && !taken.Contains(p.Id))
            .Select(p => StartOf(p.Id) is { } started ? new TaskProcess(p.Id, started) : null)
            .OfType<TaskProcess>()
            .Where(p => (p.Started - startedAt).Duration() <= Around)
            .MaxBy(p => p.Started);
    }

    public bool Stop(TaskProcess task)
    {
        try
        {
            using var process = Process.GetProcessById(task.Pid);
            if (process.StartTime != task.Started)
            {
                return false;
            }
            process.Kill(entireProcessTree: true);
            return true;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }

    private static bool Named(ProcessEntry process, string[] names) =>
        names.Contains(Path.GetFileNameWithoutExtension(process.Exe), StringComparer.OrdinalIgnoreCase);

    private static DateTime? StartOf(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.StartTime;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return null;
        }
    }
}
