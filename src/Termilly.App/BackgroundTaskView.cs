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
/// its output file and, once ended, when (Unix milliseconds). Stopping: Stop was clicked and its end hasn't shown yet;
/// StopFailed: Stop just found nothing to end. Both while it runs.
/// </summary>
internal sealed record TaskView(
    string Id, string? Command, string? Description, long StartedAt, string State, int? ExitCode, string? LastLine, string? OutputFile, long? EndedAt,
    bool Stopping = false, bool StopFailed = false);
