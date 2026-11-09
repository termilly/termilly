namespace Termilly.Desktop.Messaging;

// Settings › Privacy › History (HistoryManager.cs, js/settings/history.js): the summary, clearing part of history,
// exporting it, and the note when it passes the size the user set.

/// <summary>An open terminal, for the export: its id and the name it shows.</summary>
internal sealed record HistoryOpenTerminal(string Id = "", string Name = "");

internal static partial class FromPage
{
    /// <summary>The summary (answered with history:stats); Open are the open terminals' ids.</summary>
    internal sealed record HistoryStatsRequest(string? RequestId = null, string[]? Open = null) : IPageMessage
    {
        public static string Type => "history:stats";
    }

    /// <summary>Clears what the plan says, or with DryRun says what it would (answered with history:removed).</summary>
    internal sealed record HistoryRemove(string? RequestId = null, HistoryPlan? Plan = null, bool DryRun = true) : IPageMessage
    {
        public static string Type => "history:remove";
    }

    /// <summary>Exports history as a zip of plain text, to a file the user picks (answered with history:exported).</summary>
    internal sealed record HistoryExport(string? RequestId = null, HistoryOpenTerminal[]? Open = null) : IPageMessage
    {
        public static string Type => "history:export";
    }
}

internal static partial class ToPage
{
    internal sealed record HistoryStatsResult(string? RequestId, HistoryStats? Stats) : IHostMessage
    {
        public static string Type => "history:stats";
    }

    internal sealed record HistoryRemoved(string? RequestId, HistoryRemoval? Result, bool DryRun) : IHostMessage
    {
        public static string Type => "history:removed";
    }

    /// <param name="Path">Where it went; null when the user cancelled or it failed (Error says why).</param>
    internal sealed record HistoryExported(string? RequestId, string? Path, string? Error) : IHostMessage
    {
        public static string Type => "history:exported";
    }

    /// <summary>History passed the size the user set (Bytes, Limit in bytes): the page offers to free up space.</summary>
    internal sealed record HistoryOverLimit(long Bytes, long Limit) : IHostMessage
    {
        public static string Type => "history:overLimit";
    }
}
