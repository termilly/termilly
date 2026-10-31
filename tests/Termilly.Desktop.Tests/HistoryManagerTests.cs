using System.IO;
using System.IO.Compression;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

public sealed class HistoryManagerTests : IDisposable
{
    private sealed class Settings : ISettingsStore
    {
        public AppSettings Current { get; set; } = new() { Session = new() { HistoryDays = SettingValues.HistoryDays.Forever } };
        public event Action<SettingsSaved>? Saved;
        public void Save(AppSettings settings) => Saved?.Invoke(new SettingsSaved(Current, Current = settings));
    }

    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly Vault _vault;
    private readonly HistoryStore _closed;
    private readonly EarlierOutput _earlier;
    private readonly CommandHistory _commands;
    private readonly HistoryManager _history;
    private readonly long _now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    public HistoryManagerTests()
    {
        _vault = Vault.Open(_dir);
        _closed = new HistoryStore(_vault);
        _earlier = new EarlierOutput(_vault);
        _commands = new CommandHistory(_vault);
        _history = new HistoryManager(_vault, new Settings(), _closed, _earlier, _commands, new SessionSnapshot(_vault));
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private long DaysAgo(int days) => _now - (long)TimeSpan.FromDays(days).TotalMilliseconds;

    private void Closed(string id, string name, string ws, int daysAgo, string[]? tags = null, string? earlierOf = null)
    {
        var entry = new JsonObject
        {
            ["id"] = id, ["name"] = name, ["wsName"] = ws, ["closedAt"] = DaysAgo(daysAgo), ["profile"] = "pwsh",
            ["tags"] = new JsonArray((tags ?? []).Select(t => (JsonNode?)t).ToArray()),
            ["lines"] = new JsonArray("$ npm test", $"output of {name}"), ["earlier"] = earlierOf,
        };
        _closed.Add(JsonDocument.Parse(entry.ToJsonString()).RootElement, redactSecrets: false);
    }

    private void Commands()
    {
        _commands.Import(
        [
            new JsonObject { ["id"] = "c1", ["command"] = "git push", ["at"] = DaysAgo(200), ["workspace"] = "api" },
            new JsonObject { ["id"] = "c2", ["command"] = "npm test", ["at"] = DaysAgo(1), ["workspace"] = "web" },
        ], "laptop");
        _commands.Add(JsonDocument.Parse($$"""{"command":"dotnet build","at":{{DaysAgo(150)}},"workspace":"api"}""").RootElement, redactSecrets: false);
        _commands.Add(JsonDocument.Parse($$"""{"command":"ls","at":{{DaysAgo(2)}},"workspace":"web"}""").RootElement, redactSecrets: false);
    }

    [Fact]
    public void The_summary_counts_each_kind_with_its_size_the_oldest_and_the_largest()
    {
        Closed("h1", "claude", "api", 120, ["client-a"], earlierOf: "t-old");
        _earlier.Append("t-old", Enumerable.Range(0, 500).Select(i => $"earlier line {i}").ToList(), redactSecrets: false);
        Closed("h2", "tests", "web", 3);
        _earlier.Append("t-open", ["still open"], redactSecrets: false);
        Commands();

        var stats = _history.Stats(["t-open"]);
        var kinds = stats.Kinds.ToDictionary(k => k.Kind);
        Assert.Equal((2, 504L), (kinds["closed"].Count, kinds["closed"].Lines)); // 2 lines each, and 500 earlier
        Assert.Equal((1, 1L), (kinds["earlier"].Count, kinds["earlier"].Lines));
        Assert.Equal((2, 2), (kinds["commands"].Count, kinds["synced"].Count));
        Assert.True(kinds["commands"].Bytes > 0 && kinds["closed"].Bytes > kinds["earlier"].Bytes);
        Assert.True(stats.Total >= stats.Kinds.Sum(k => k.Bytes) - 1);
        Assert.Equal("git push", stats.OldestName); // the laptop's command, 200 days ago
        Assert.Equal("claude", stats.Largest[0].Name);
        Assert.Equal(new HistoryHost("laptop", 2), Assert.Single(stats.Hosts));
        Assert.Equal(["api", "web"], stats.Workspaces.Select(w => w.Name).Order());
        Assert.Equal(1, stats.Workspaces.Single(w => w.Name == "api").Commands);
        Assert.Equal("client-a", Assert.Single(stats.Tags).Name);
    }

    [Fact]
    public void Clearing_before_a_date_says_first_what_goes_then_takes_only_that()
    {
        Closed("h1", "old", "api", 120, earlierOf: "t-old");
        _earlier.Append("t-old", ["old output"], redactSecrets: false);
        Closed("h2", "new", "web", 3);
        Commands();
        var plan = new HistoryPlan { Before = DaysAgo(90), Kinds = ["closed", "commands"] };

        var preview = _history.Remove(plan, dryRun: true);
        Assert.Equal((1, 1, 0), (preview.Closed, preview.Commands, preview.Synced));
        Assert.True(preview.Bytes > 0);
        Assert.Equal(2, _closed.Entries(SettingValues.HistoryDays.Forever).Count); // nothing went yet

        var done = _history.Remove(plan, dryRun: false);
        Assert.Equal(preview with { }, done);
        Assert.Equal(["h2"], _closed.Entries(SettingValues.HistoryDays.Forever).Select(e => e.Id));
        Assert.Empty(_earlier.Lines("t-old"));
        Assert.Equal(3, _commands.Read(l => l.Count)); // the laptop's old one stays: synced wasn't asked
    }

    [Fact]
    public void Clearing_by_workspace_or_tag_takes_their_closed_terminals_and_the_workspaces_commands()
    {
        Closed("h1", "a", "api", 10);
        Closed("h2", "b", "web", 10, ["client-a"]);
        Closed("h3", "c", "web", 10);
        Commands();

        var done = _history.Remove(new HistoryPlan { Kinds = ["closed", "commands", "synced"], Workspaces = ["API"], Tags = ["client-a"] }, dryRun: false);
        Assert.Equal((2, 1, 0), (done.Closed, done.Commands, done.Synced)); // synced commands aren't by workspace
        Assert.Equal(["h3"], _closed.Entries(SettingValues.HistoryDays.Forever).Select(e => e.Id));
    }

    [Fact]
    public void Free_up_space_takes_output_and_keeps_the_terminals_and_old_earlier_output_goes_by_date()
    {
        Closed("h1", "kept by name", "api", 200, earlierOf: "t-old");
        _earlier.Append("t-old", ["old earlier output"], redactSecrets: false);
        Closed("h2", "recent", "api", 5);

        var done = _history.Remove(new HistoryPlan { Before = DaysAgo(180), Kinds = ["closed"], OutputOnly = true }, dryRun: false);
        Assert.Equal(1, done.Closed);
        var kept = JsonNode.Parse(_closed.Entries(SettingValues.HistoryDays.Forever).Single(e => e.Id == "h1").Json)!;
        Assert.Equal("kept by name", kept["name"]!.GetValue<string>());
        Assert.Empty(kept["lines"]!.AsArray());
        Assert.Empty(_earlier.Lines("t-old"));

        _earlier.Append("t-open", ["new"], redactSecrets: false);
        var earlierGone = _history.Remove(new HistoryPlan { Before = DaysAgo(30), Kinds = ["earlier", "closedEarlier"], EarlierIds = ["t-open"] }, dryRun: false);
        Assert.Equal(0, earlierGone.Earlier); // kept today: not older than 30 days
        Assert.Equal(["new"], _earlier.Lines("t-open"));
    }

    [Fact]
    public void Export_writes_plain_text_for_each_terminal_and_the_commands()
    {
        Closed("h1", "claude", "api", 2, earlierOf: "t-old");
        _earlier.Append("t-old", ["the address is 192.168.0.108:8790"], redactSecrets: false);
        _earlier.Append("t-open", ["open terminal's earlier output"], redactSecrets: false);
        Commands();
        var file = Path.Combine(_dir, "export.zip");

        _history.Export(file, new Dictionary<string, string> { ["t-open"] = "build-01" });

        using var zip = ZipFile.OpenRead(file);
        var names = zip.Entries.Select(e => e.FullName).ToList();
        Assert.Contains("open/build-01.txt", names);
        Assert.Contains("commands.txt", names);
        var closed = zip.Entries.Single(e => e.FullName.StartsWith("closed/", StringComparison.Ordinal));
        using var reader = new StreamReader(closed.Open());
        var text = reader.ReadToEnd();
        Assert.Contains("192.168.0.108:8790", text);
        Assert.Contains("output of claude", text);
    }
}
