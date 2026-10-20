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
    public void Old_commands_expire()
    {
        _history.Add(Entry("old", at: DateTimeOffset.UtcNow.AddDays(-40).ToUnixTimeMilliseconds()), redactSecrets: false);
        _history.Add(Entry("new"), redactSecrets: false);
        Assert.Equal(["new"], JsonNode.Parse(_history.List(30))!.AsArray().Select(e => e!["command"]!.GetValue<string>()));
    }
}
