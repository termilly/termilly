using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class CodexUsageTests : IDisposable
{
    private const string Session = "01a1c258-2218-7580-bd28-057b0ebfae3d";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-codex-" + Guid.NewGuid().ToString("N"));

    public CodexUsageTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private const string Meta = """{"timestamp":"2026-11-09T22:05:18.684Z","type":"session_meta","payload":{"id":"01a1c258-2218-7580-bd28-057b0ebfae3d","cwd":"C:\\nowhere","cli_version":"0.167.0"}}""";
    private const string Turn = """{"timestamp":"2026-11-09T22:05:19.479Z","type":"turn_context","payload":{"cwd":"C:\\nowhere","model":"gpt-6.1-sol"}}""";
    private const string Reply = """{"timestamp":"2026-11-09T22:05:20.000Z","type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"token_count is a word here"}]}}""";

    private static string Count(long input, long cached, long output, long last, double fiveHour, double week) =>
        "{\"timestamp\":\"2026-11-09T22:05:25.814Z\",\"type\":\"event_msg\",\"payload\":{\"type\":\"token_count\",\"info\":{"
        + $"\"total_token_usage\":{{\"input_tokens\":{input},\"cached_input_tokens\":{cached},\"output_tokens\":{output},\"total_tokens\":{input + output}}},"
        + $"\"last_token_usage\":{{\"input_tokens\":{last},\"output_tokens\":0,\"total_tokens\":{last}}},\"model_context_window\":475000}},"
        + $"\"rate_limits\":{{\"primary\":{{\"used_percent\":{fiveHour},\"window_minutes\":300,\"resets_at\":1794275366}},"
        + $"\"secondary\":{{\"used_percent\":{week},\"window_minutes\":10080,\"resets_at\":1794821462}}}}}}}}";

    private string Rollout(params string[] lines)
    {
        var folder = Directory.CreateDirectory(Path.Combine(_dir, "2026", "11", "09")).FullName;
        var path = Path.Combine(folder, $"rollout-2026-11-09T23-05-18-{Session}.jsonl");
        File.WriteAllText(path, string.Join("\n", lines) + "\n");
        return path;
    }

    [Fact]
    public void A_rollout_gives_the_model_tokens_context_and_the_plan_limits()
    {
        PlanLimits? limits = null;
        var reader = new CodexRollout(Rollout(Meta, Turn, Reply, Count(35573, 30080, 79, 17860, 2, 4)), Session, l => limits = l);
        Assert.True(reader.Read());
        var u = reader.Usage;
        Assert.Equal(("gpt-6.1-sol", 475_000L, 17_860L, "0.167.0"), (u.Model, u.ContextWindow, u.Context, u.Version));
        Assert.Equal((35573L - 30080L, 30080L, 79L, 1), (u.Input, u.CacheRead, u.Output, u.Replies));
        Assert.Equal(DateTimeOffset.Parse("2026-11-09T22:05:18.684Z", System.Globalization.CultureInfo.InvariantCulture), u.Started);
        Assert.NotNull(limits);
        Assert.Equal((2.0, 1794275366L), (limits.FiveHour!.Used, limits.FiveHour.ResetsAt));
        Assert.Equal(4.0, limits.SevenDay!.Used);
        Assert.Null(u.EstimatedUsd); // only Claude's models are priced
    }

    [Fact]
    public void Only_what_was_added_is_read_and_the_newest_count_wins()
    {
        var path = Rollout(Meta, Turn, Count(100, 0, 10, 100, 1, 1));
        var reader = new CodexRollout(path, Session, _ => { });
        Assert.True(reader.Read());
        Assert.False(reader.Read());
        File.AppendAllText(path, Count(300, 100, 30, 250, 3, 1) + "\n");
        Assert.True(reader.Read());
        Assert.Equal((200L, 100L, 30L, 250L, 2), (reader.Usage.Input, reader.Usage.CacheRead, reader.Usage.Output, reader.Usage.Context, reader.Usage.Replies));
    }

    [Fact]
    public void The_tracker_finds_a_session_by_its_id_in_the_day_folders()
    {
        Rollout(Meta, Turn, Count(100, 0, 10, 100, 1, 1));
        var reports = new List<ClaudeUsage>();
        using var tracker = new UsageTracker((_, usage) => { lock (reports) { reports.Add(usage); } }, CodexFiles.Source(_dir, _ => { }));
        tracker.Track("pane-1", Session);
        tracker.Tick();
        // Track reads in the background too, and a Tick meanwhile leaves it to that one: the report follows shortly.
        bool Reported()
        {
            lock (reports)
            {
                return reports.Any(r => r.Session == Session && r.Model == "gpt-6.1-sol");
            }
        }
        Assert.True(SpinWait.SpinUntil(Reported, TimeSpan.FromSeconds(5)));
        Assert.Null(UsageTracker.FindFile(_dir, "../escape", "*"));
    }

    [Fact]
    public void Codex_lists_the_models_its_own_picker_shows_in_its_order()
    {
        File.WriteAllText(Path.Combine(_dir, CodexFiles.ModelsCache), """
            {"models":[
              {"slug":"gpt-6-astra","display_name":"GPT-6-Astra","visibility":"list","priority":2},
              {"slug":"gpt-reserve","display_name":"GPT-Reserve","visibility":"hide","priority":1},
              {"slug":"gpt-6.1-sol","display_name":"GPT-6.1-Sol","description":"Workhorse","visibility":"list","priority":1}
            ]}
            """);
        var models = CodexModels.Read(_dir);
        Assert.Equal(["gpt-6.1-sol", "gpt-6-astra"], models.Select(m => m.Slug));
        Assert.Equal("Workhorse", models[0].Description);
        Assert.Empty(CodexModels.Read(Path.Combine(_dir, "missing")));
    }

    [Fact]
    public void A_new_session_starts_with_configs_model_else_the_first_listed()
    {
        IReadOnlyList<CodexModel> models = [new("gpt-6.1-sol", "GPT-6.1-Sol", null), new("gpt-6-astra", "GPT-6-Astra", null)];
        Assert.Equal("gpt-6.1-sol", CodexModels.Default(models, _dir)); // no config.toml
        File.WriteAllText(Path.Combine(_dir, "config.toml"), "approval_policy = \"never\"\n\n[profiles.fast]\nmodel = \"gpt-5.6-luna\"\n");
        Assert.Equal("gpt-6.1-sol", CodexModels.Default(models, _dir)); // a profile's model isn't the default
        File.WriteAllText(Path.Combine(_dir, "config.toml"), "model = \"gpt-6-astra\"\n[profiles.fast]\nmodel = \"gpt-5.6-luna\"\n");
        Assert.Equal("gpt-6-astra", CodexModels.Default(models, _dir));
        Assert.Null(CodexModels.Default([], Path.Combine(_dir, "missing")));
    }
}
