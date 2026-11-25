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
/// under the terminal are the task's. The topmost of them ends, with everything it runs.
/// </summary>
internal sealed class TaskProcesses : ITaskProcesses
{
    public bool Stop(int terminalPid, string outputFile)
    {
        var below = ClaudeAgentsPoller.Descendants(BusyWatcher.Snapshot(), terminalPid);
        var parents = below.ToDictionary(p => p.Id, p => p.ParentId);
        var holders = FileHolders.Of(outputFile, parents.Keys).Where(parents.ContainsKey).ToHashSet();
        var top = holders.Where(pid => !holders.Contains(parents[pid])).ToList();
        var stopped = false;
        foreach (var pid in top)
        {
            stopped |= Kill(pid); // each one, not just up to the first that ends
        }
        return stopped;
    }

    private static bool Kill(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            process.Kill(entireProcessTree: true);
            return true;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return false;
        }
    }
}
