using System.Globalization;
using Microsoft.Web.WebView2.Core;

namespace Termilly.Desktop;

/// <summary>
/// WebView2's own crashes (the page's process ending shows "This page is having a problem"). Its crash reports stay
/// in the data folder (EBWebView\Crashpad\reports) instead of going to Microsoft, and each failure is noted in
/// crash.log with what WebView2 says about it, so a crash can be looked into afterwards.
/// </summary>
internal static class PageCrashes
{
    /// <summary>The environment's options: crash reports kept, with <paramref name="arguments"/> for the browser (or none).</summary>
    public static CoreWebView2EnvironmentOptions Options(string? arguments) =>
        new(arguments) { IsCustomCrashReportingEnabled = true };

    /// <summary>
    /// Notes every process the main window's WebView2 loses in crash.log, from now on. Only the main window's: detached
    /// windows share its browser and GPU processes, and each would note the same failure again. A page that's merely
    /// slow (unresponsive, reported again every few seconds) isn't a crash and isn't noted.
    /// </summary>
    public static void Follow(CoreWebView2 core) =>
        core.ProcessFailed += (_, e) =>
        {
            if (e.ProcessFailedKind == CoreWebView2ProcessFailedKind.RenderProcessUnresponsive)
            {
                return;
            }
            var what = Describe(e, ReportFolder(core));
            var when = DateTimeOffset.Now;
            _ = Task.Run(() => CrashLog.Note(CrashLog.PathOf(CrashLog.FileName), what, when)); // off the window's thread
        };

    /// <summary>What failed, why, its exit code (hex, as Windows names them: 0x80000003 is STATUS_BREAKPOINT) and where reports are.</summary>
    internal static string Describe(CoreWebView2ProcessFailedEventArgs e, string? reports)
    {
        var what = $"WebView2: {e.ProcessFailedKind}";
        try
        {
            what += $", {e.Reason}, exit code 0x{e.ExitCode.ToString("X8", CultureInfo.InvariantCulture)}";
            if (!string.IsNullOrEmpty(e.ProcessDescription))
            {
                what += $" ({e.ProcessDescription})";
            }
            if (!string.IsNullOrEmpty(e.FailureSourceModulePath))
            {
                what += $", in {e.FailureSourceModulePath}";
            }
        }
        catch (NotImplementedException)
        {
            // A WebView2 runtime older than these details: the kind alone.
        }
        return reports is null ? what : $"{what}{Environment.NewLine}Crash reports: {reports}";
    }

    private static string? ReportFolder(CoreWebView2 core)
    {
        try
        {
            return core.Environment.FailureReportFolderPath;
        }
        catch (NotImplementedException)
        {
            return null;
        }
    }
}
