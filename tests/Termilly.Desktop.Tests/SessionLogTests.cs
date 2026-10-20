using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class SessionLogTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"termilly-log-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    private string[] Plain(Action<SessionLog> feed, bool redact = true, bool timestamps = false)
    {
        var path = Path.Combine(_dir, "ws", "t.log");
        using (var log = new SessionLog(path, raw: false, timestamps, redact))
        {
            feed(log);
        }
        return File.ReadAllLines(path);
    }

    [Fact]
    public void Plain_logs_keep_the_lines_and_marks_the_page_sends()
    {
        var lines = Plain(log =>
        {
            log.Output("\u001b[32mstream\u001b[0m\r\n"); // the stream is only for raw logs
            log.Lines(["$ git push", "Everything up-to-date", "[exit 0, 1.2 s]"]);
        });

        Assert.StartsWith("# Termilly session log, started", lines[0]);
        Assert.Equal(["$ git push", "Everything up-to-date", "[exit 0, 1.2 s]"], lines[1..^1]);
        Assert.StartsWith("# ended", lines[^1]);
    }

    [Fact]
    public void Lines_can_carry_the_time()
    {
        var lines = Plain(log => log.Lines(["hello"]), timestamps: true);

        Assert.Matches(@"^\[\d\d:\d\d:\d\d\] hello$", lines[1]);
    }

    [Fact]
    public void Secrets_are_redacted_unless_turned_off()
    {
        const string token = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";
        Assert.DoesNotContain(token, string.Join('\n', Plain(log => log.Lines([$"token={token}"]))));
        Assert.Contains(token, string.Join('\n', Plain(log => log.Lines([$"token={token}"]), redact: false)));
    }

    [Fact]
    public void Raw_logs_keep_the_stream_as_it_came()
    {
        var path = Path.Combine(_dir, "raw.log");
        using (var log = new SessionLog(path, raw: true, timestamps: false, redact: false))
        {
            log.Output("\u001b[1mbold\u001b[0m\r\n");
            log.Lines(["not for raw logs"]);
        }
        Assert.Equal("\u001b[1mbold\u001b[0m\r\n", File.ReadAllText(path));
    }

    [Fact]
    public void Log_names_follow_the_workspace_and_terminal()
    {
        var path = SessionLog.PathFor(@"C:\logs", "api: server", "npm run dev?", new DateTime(2026, 10, 12, 9, 5, 1), raw: false);

        Assert.Equal(@"C:\logs\api server\npm run dev_2026-10-12_09-05-01.log", path);
    }

    [Fact]
    public void A_full_file_goes_on_in_a_new_part()
    {
        var path = Path.Combine(_dir, "big.log");
        string current;
        using (var log = new SessionLog(path, raw: true, timestamps: false, redact: false, maxBytes: 100))
        {
            log.Output(new string('x', 150));
            log.Output("more");
            current = log.Path;
        }
        Assert.EndsWith("big_2.log", current);
        Assert.Equal("more", File.ReadAllText(current));
    }

    [Fact]
    public void Old_logs_are_deleted_after_the_days_set()
    {
        Directory.CreateDirectory(_dir);
        var old = Path.Combine(_dir, "old.log");
        var recent = Path.Combine(_dir, "recent.log");
        File.WriteAllText(old, "");
        File.WriteAllText(recent, "");
        File.SetLastWriteTime(old, DateTime.Now.AddDays(-40));

        SessionLog.DeleteOld(_dir, 30);

        Assert.False(File.Exists(old));
        Assert.True(File.Exists(recent));
    }
}
