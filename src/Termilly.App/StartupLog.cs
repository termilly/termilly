using System.Diagnostics;
using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// startup.log in the data folder: when each step of a start happened, in milliseconds since the process started, so a
/// slow start (after an update, say) shows where its time went. Only a start's first minute is logged, and the file
/// keeps the last few starts.
/// </summary>
internal static class StartupLog
{
    private const string FileName = "startup.log";
    /// <summary>About ten starts' worth.</summary>
    private const int KeepLines = 600;
    private static readonly TimeSpan LogFor = TimeSpan.FromMinutes(1);
    private static readonly Lock Gate = new();
    private static readonly DateTime ProcessStarted = StartTime();
    private static bool _begun;

    /// <summary>The longest step the page may note: a line of the log, not a place to keep text.</summary>
    private const int MaxPageStep = 200;

    /// <summary>
    /// Notes a step the page reported, cut short and without control characters (a line of its own, whatever it
    /// says); nothing when it says nothing.
    /// </summary>
    public static void MarkFromPage(string? step)
    {
        if (string.IsNullOrWhiteSpace(step))
        {
            return;
        }
        var line = new string([.. step.Take(MaxPageStep).Select(c => char.IsControl(c) ? ' ' : c)]);
        Mark($"page: {line}");
    }

    /// <summary>Notes that <paramref name="step"/> happened now; never throws.</summary>
    public static void Mark(string step)
    {
        var since = DateTime.Now - ProcessStarted;
        if (since > LogFor)
        {
            return;
        }
        var file = Path.Combine(AppPaths.DataDirectory, FileName);
        lock (Gate)
        {
            try
            {
                if (!_begun)
                {
                    _begun = true;
                    Directory.CreateDirectory(AppPaths.DataDirectory);
                    if (File.Exists(file))
                    {
                        var lines = File.ReadAllLines(file);
                        if (lines.Length > KeepLines)
                        {
                            File.WriteAllLines(file, lines[^KeepLines..]);
                        }
                    }
                    File.AppendAllText(file, $"== {ProcessStarted:yyyy-MM-dd HH:mm:ss.fff} Termilly {AppVersion.Current} started (pid {Environment.ProcessId})" + Environment.NewLine);
                }
                File.AppendAllText(file, $"{DateTime.Now:HH:mm:ss.fff} +{since.TotalMilliseconds,6:0} ms  {step}" + Environment.NewLine);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // The log is a help, never a reason to fail.
            }
        }
    }

    private static DateTime StartTime()
    {
        try
        {
            using var self = Process.GetCurrentProcess();
            return self.StartTime;
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            return DateTime.Now;
        }
    }
}
