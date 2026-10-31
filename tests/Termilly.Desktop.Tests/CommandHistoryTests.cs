using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

public sealed class CommandHistoryTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    private readonly Vault _vault;
    private readonly CommandHistory _history;

    public CommandHistoryTests()
    {
        _vault = Vault.Open(_dir);
        _history = new CommandHistory(_vault);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static JsonElement Entry(string command, int? exitCode = 0, long? at = null) =>
        JsonDocument.Parse(new JsonObject
        {
            ["command"] = command, ["exitCode"] = exitCode, ["durationMs"] = 1200, ["cwd"] = @"C:\dev",
            ["at"] = at ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["terminal"] = "PowerShell", ["workspace"] = "api",
        }.ToJsonString()).RootElement;

    [Fact]
    public void Commands_are_kept_encrypted_newest_first_and_survive_a_restart()
    {
        _history.Add(Entry("npm test", 1), redactSecrets: false);
        _history.Add(Entry("git status"), redactSecrets: false);
        _history.Reset(); // as after a restart: read back from the file

        var list = JsonNode.Parse(_history.List(30))!.AsArray();
        Assert.Equal(["git status", "npm test"], list.Select(e => e!["command"]!.GetValue<string>()));
        Assert.Equal(1, list[1]!["exitCode"]!.GetValue<int>());
        Assert.DoesNotContain("npm test", File.ReadAllText(Path.Combine(_vault.HistoryDirectory, "commands.tmc")));
    }

    [Fact]
    public void Secrets_are_redacted_and_blank_or_huge_commands_skipped()
    {
        _history.Add(Entry("net user admin Hunter2Secret! /add"), redactSecrets: true);
        _history.Add(Entry("   "), redactSecrets: false);
        _history.Add(Entry(new string('x', 3000)), redactSecrets: false);

        var only = Assert.Single(JsonNode.Parse(_history.List(30))!.AsArray());
        Assert.DoesNotContain("Hunter2Secret!", only!["command"]!.GetValue<string>());
    }

    [Fact]
    public void Forever_keeps_every_command_however_old_or_many()
    {
        _history.Add(Entry("ancient", at: DateTimeOffset.UtcNow.AddYears(-20).ToUnixTimeMilliseconds()), redactSecrets: false);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        _history.Import(Enumerable.Range(0, 6000).Select(i => new JsonObject { ["id"] = $"c{i}", ["command"] = $"cmd {i}", ["at"] = now - i }), "laptop");
        var all = JsonNode.Parse(_history.List(SettingValues.HistoryDays.Forever))!.AsArray();
        Assert.Equal(6001, all.Count);
        Assert.Equal("ancient", all[^1]!["command"]!.GetValue<string>());
    }

    [Fact]
    public void Closed_terminals_are_kept_by_age_alone_and_forever_keeps_them_all()
    {
        var closed = new HistoryStore(_vault);
        var old = DateTimeOffset.UtcNow.AddDays(-400).ToUnixTimeMilliseconds();
        closed.Add(JsonDocument.Parse($$"""{"id":"old","closedAt":{{old}},"lines":["kept a long time"]}""").RootElement, redactSecrets: false);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var i = 0; i < 320; i++)
        {
            closed.Add(JsonDocument.Parse($$"""{"id":"t{{i}}","closedAt":{{now - i}}}""").RootElement, redactSecrets: false);
        }

        using (var forever = closed.List(SettingValues.HistoryDays.Forever))
        {
            Assert.Equal(321, forever.RootElement.GetArrayLength()); // no cap on how many
        }
        using (var year = closed.List(365))
        {
            Assert.Equal(320, year.RootElement.GetArrayLength()); // the 400-day-old one is past it
        }
    }

    [Fact]
    public void Old_commands_expire()
    {
        _history.Add(Entry("old", at: DateTimeOffset.UtcNow.AddDays(-40).ToUnixTimeMilliseconds()), redactSecrets: false);
        _history.Add(Entry("new"), redactSecrets: false);
        Assert.Equal(["new"], JsonNode.Parse(_history.List(30))!.AsArray().Select(e => e!["command"]!.GetValue<string>()));
    }
}
