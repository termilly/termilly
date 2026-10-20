using System.IO;
using Termilly.Shared;

namespace Termilly.Desktop.Tests;

public sealed class CrashLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static OperationCanceledException Thrown()
    {
        try
        {
            throw new OperationCanceledException("The operation was canceled.");
        }
        catch (OperationCanceledException e)
        {
            return e;
        }
    }

    [Fact]
    public void A_crash_is_added_with_its_time_version_and_stack_trace()
    {
        var path = Path.Combine(_dir, CrashLog.FileName);
        var when = new DateTimeOffset(2026, 10, 18, 23, 51, 25, TimeSpan.FromHours(2));

        CrashLog.Write(path, Thrown(), when);
        CrashLog.Write(path, new InvalidOperationException("second"), when);

        var log = File.ReadAllText(path);
        Assert.StartsWith($"2026-10-18 23:51:25 +02:00  Termilly {AppVersion.Current} on ", log);
        Assert.Contains("System.OperationCanceledException: The operation was canceled.", log);
        Assert.Contains(nameof(Thrown), log);
        Assert.Contains("System.InvalidOperationException: second", log);
    }

    [Fact]
    public void A_full_log_is_moved_aside_and_a_new_one_started()
    {
        var path = Path.Combine(_dir, CrashLog.FileName);
        Directory.CreateDirectory(_dir);
        File.WriteAllText(path, new string('x', 1024 * 1024));

        CrashLog.Write(path, Thrown(), DateTimeOffset.Now);

        Assert.Equal(1024 * 1024, new FileInfo(Path.Combine(_dir, "crash.old.log")).Length);
        Assert.Contains("OperationCanceledException", File.ReadAllText(path));
    }

    [Fact]
    public void Recent_lists_the_logs_written_lately_newest_first()
    {
        Directory.CreateDirectory(_dir);
        var app = Path.Combine(_dir, CrashLog.FileName);
        var host = Path.Combine(_dir, CrashLog.HostFileName);
        var helper = Path.Combine(_dir, CrashLog.HelperFileName);
        foreach (var path in new[] { app, host, helper })
        {
            File.WriteAllText(path, "crash");
        }
        var now = DateTimeOffset.Now;
        File.SetLastWriteTimeUtc(app, now.AddHours(-2).UtcDateTime);
        File.SetLastWriteTimeUtc(host, now.AddHours(-1).UtcDateTime);
        File.SetLastWriteTimeUtc(helper, now.AddDays(-30).UtcDateTime);

        var recent = CrashLog.Recent(_dir, now - CrashLog.RecentFor);

        Assert.Equal([host, app], recent.Select(c => c.Path));
    }
}
