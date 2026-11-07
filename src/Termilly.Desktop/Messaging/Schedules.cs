namespace Termilly.Desktop.Messaging;

// Schedules (js/schedules.js): the page keeps them and decides when each is due; here a run out of sight goes through a
// hidden shell, and its output is kept encrypted (Features/Schedules.cs).

internal static partial class FromPage
{
    /// <summary>
    /// Runs <see cref="Command"/> once, out of sight, in a shell of <see cref="Profile"/>. With a server's profile,
    /// <see cref="Cwd"/> is a folder on that server. Stopped after <see cref="LimitSeconds"/>.
    /// </summary>
    internal sealed record ScheduleRun(string RunId = "", string? Profile = null, string? Cwd = null, string Command = "", int LimitSeconds = 0) : IPageMessage
    {
        public static string Type => "schedule:run";
    }

    /// <summary>Stops a run out of sight.</summary>
    internal sealed record ScheduleStop(string RunId = "") : IPageMessage
    {
        public static string Type => "schedule:stop";
    }

    /// <summary>Keeps the output of a run that happened in a terminal, as a run out of sight's is kept.</summary>
    internal sealed record ScheduleKeep(string RunId = "", string Output = "") : IPageMessage
    {
        public static string Type => "schedule:keep";
    }

    /// <summary>
    /// Adds a run's report to a file: a new one, or at the end of one that's there. A name with no folder goes in Documents\Termilly.
    /// </summary>
    internal sealed record ScheduleSaveFile(string RunId = "", string Path = "", string Text = "") : IPageMessage
    {
        public static string Type => "schedule:save-file";
    }

    /// <summary>Asks for a run's kept output.</summary>
    internal sealed record ScheduleReportRead(string? RequestId = null, string RunId = "") : IPageMessage
    {
        public static string Type => "schedule:report-read";
    }

    /// <summary>Runs whose time has passed: their output goes.</summary>
    internal sealed record ScheduleForget(IReadOnlyList<string>? RunIds = null) : IPageMessage
    {
        public static string Type => "schedule:forget";
    }
}

internal static partial class ToPage
{
    /// <summary>
    /// The clock: the page looks for what's due. It comes from here because a hidden window's own timers can be held back
    /// to about one a minute, and the window lives in the tray for days.
    /// </summary>
    internal sealed record ScheduleTick : IHostMessage
    {
        public static string Type => "schedule:tick";
    }

    /// <summary>
    /// A run out of sight ended: its exit code, unless it was <see cref="Stopped"/> or couldn't start (<see cref="Error"/>),
    /// and the end of its output with secrets taken out, for the run's summary.
    /// </summary>
    internal sealed record ScheduleEnded(string RunId, int? ExitCode, string Tail, bool Stopped = false, string? Error = null) : IHostMessage
    {
        public static string Type => "schedule:ended";
    }

    /// <summary>Where a run's report was saved, or why it couldn't be.</summary>
    internal sealed record ScheduleFileSaved(string RunId, string? Path, string? Error = null) : IHostMessage
    {
        public static string Type => "schedule:file-saved";
    }

    /// <summary>A run's kept output as the terminal printed it, and how wide that terminal was; null when it's gone.</summary>
    internal sealed record ScheduleReport(string? RequestId, string? Output, int Columns) : IHostMessage
    {
        public static string Type => "schedule:report";
    }
}
