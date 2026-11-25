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

/// <summary>A background task's process: the shell an agent started it in, and what that shell runs.</summary>
internal interface ITaskProcesses
{
    /// <summary>
    /// Ends the task whose output goes to <paramref name="outputFile"/>, under the terminal's root process: false when
    /// none is found (it ended already).
    /// </summary>
    bool Stop(int terminalPid, string outputFile);
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

    public bool Stop(int terminalPid, string outputFile)
    {
        var all = BusyWatcher.Snapshot();
        var below = ClaudeAgentsPoller.Descendants(all, terminalPid).ToDictionary(p => p.Id);
        // The agent may be the terminal's own program, not only one its shell started.
        var agents = below.Values.Concat(all.Where(p => p.Id == terminalPid))
            .Where(p => _starters.Contains(Path.GetFileNameWithoutExtension(p.Exe), StringComparer.OrdinalIgnoreCase))
            .Select(p => p.Id).ToHashSet();
        var tasks = FileHolders.Of(outputFile, below.Keys).Where(pid => below.TryGetValue(pid, out var p) && agents.Contains(p.ParentId)).ToList();
        // Held open while it's checked again: a process that ended meanwhile can't hand its id to another one.
        var opened = tasks.Select(Open).OfType<Process>().ToList();
        try
        {
            var still = FileHolders.Of(outputFile, below.Keys).ToHashSet();
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
