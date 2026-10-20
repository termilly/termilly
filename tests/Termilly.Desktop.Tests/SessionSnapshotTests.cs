using System.IO;
using System.Text.Json;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class SessionSnapshotTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    private readonly SessionSnapshot _snapshot;

    public SessionSnapshotTests() => _snapshot = new SessionSnapshot(Vault.Open(_dir));

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Snapshots_are_encrypted_trimmed_and_redacted()
    {
        var lines = Enumerable.Range(1, 800).Select(i => $"line {i}").Append("net user admin Hunter2Secret! /add").ToArray();
        var snapshot = JsonSerializer.SerializeToElement(new
        {
            savedAt = 1,
            tabs = new Dictionary<string, object> { ["t1"] = new { lines, agentSession = (string?)null } },
        });

        _snapshot.Save(snapshot, redactSecrets: true);
        using var back = _snapshot.Load();

        var tab = back!.RootElement.GetProperty("tabs").GetProperty("t1");
        Assert.Equal(SessionSnapshot.MaxLines, tab.GetProperty("lines").GetArrayLength());
        Assert.DoesNotContain("Hunter2Secret!", tab.GetProperty("lines").GetRawText());
        var file = Directory.GetFiles(_dir, "session.tms").Single();
        Assert.DoesNotContain("line 799", File.ReadAllText(file));
    }

    [Fact]
    public void Restore_setting_falls_back_to_bringing_terminals_back() =>
        Assert.Equal("scrollback", new AppSettings { Session = new() { Restore = "everything" } }.Normalize().Session.Restore);
}
