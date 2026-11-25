using System.Diagnostics;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>A background task's state: running, or ended with its exit code (0: done, else failed).</summary>
internal static class TaskStates
{
    public const string Running = "running";
    public const string Done = "done";
    public const string Failed = "failed";
}

/// <summary>
/// A background task as the page shows it: what it runs and why, when it started, its state, its output's last line,
/// its output file and, once ended, when (Unix milliseconds).
/// </summary>
internal sealed record TaskView(
    string Id, string? Command, string? Description, long StartedAt, string State, int? ExitCode, string? LastLine, string? OutputFile, long? EndedAt);

/// <summary>What a background task's output file says now: where it is, its last line, and its exit code once it ended.</summary>
internal sealed record TaskReading(string Path, string? LastLine, int? ExitCode);

/// <summary>Reads a background task's output file (Claude Code writes one per task, under the temp folder).</summary>
internal interface ITaskOutput
{
    /// <summary>The task's output so far, or null while its file isn't found.</summary>
    TaskReading? Read(string session, string taskId);
}

/// <summary>Stops a background task: the shell an agent started it in, and what that shell runs.</summary>
internal interface ITaskProcesses
{
    /// <summary>Stops the task started at <paramref name="startedAt"/> under the terminal's root process; false when none is found.</summary>
    bool Stop(int terminalPid, DateTime startedAt);
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
/// Stops a task by its process: of the shells the terminal's agent started (they carry no command line here), the one
/// started nearest after the task was, with everything it runs.
/// </summary>
internal sealed class TaskProcesses : ITaskProcesses
{
    /// <summary>The shells agents run commands in.</summary>
    private static readonly string[] Shells = ["bash", "sh", "zsh", "fish", "powershell", "pwsh", "cmd"];
    /// <summary>The programs that start them: the agents (Claude Code's may run under node).</summary>
    private static readonly string[] Agents = [AgentKinds.Claude, AgentKinds.Codex, "node"];
    /// <summary>A shell may be seen to start a little before the hook said so.</summary>
    private static readonly TimeSpan Early = TimeSpan.FromSeconds(2);

    public bool Stop(int terminalPid, DateTime startedAt)
    {
        var all = BusyWatcher.Snapshot();
        var below = ClaudeAgentsPoller.Descendants(all, terminalPid);
        var agents = below.Where(p => Named(p, Agents)).Select(p => p.Id).ToHashSet();
        var task = below.Where(p => agents.Contains(p.ParentId) && Named(p, Shells))
            .Select(p => (p.Id, Started: StartOf(p.Id)))
            .Where(p => p.Started is { } at && at >= startedAt - Early)
            .OrderBy(p => p.Started)
            .FirstOrDefault();
        if (task.Id == 0)
        {
            return false;
        }
        try
        {
            using var process = Process.GetProcessById(task.Id);
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
