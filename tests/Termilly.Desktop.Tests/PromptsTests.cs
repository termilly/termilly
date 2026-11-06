using System.IO;
using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>My prompts (Features/Prompts.cs): what the user typed, out of a Claude Code transcript.</summary>
public sealed class PromptsTests
{
    private const string At = "2026-11-01T14:05:01.491Z";

    private static string UserLine(string content, string extra = "") =>
        $$"""{"type":"user"{{extra}},"message":{"role":"user","content":{{content}}},"timestamp":"{{At}}"}""";

    [Fact]
    public void A_typed_prompt_is_read_with_its_time()
    {
        var prompt = TranscriptPrompts.Prompt(UserLine("\"fix the build\""));

        Assert.NotNull(prompt);
        Assert.Equal("fix the build", prompt.Text);
        Assert.Equal(At, prompt.At);
    }

    [Fact]
    public void Text_blocks_count_and_pasted_text_loses_its_tags()
    {
        Assert.Equal("a\nb", TranscriptPrompts.Prompt(UserLine("""[{"type":"text","text":"a"},{"type":"image"},{"type":"text","text":"b"}]"""))?.Text);
        Assert.Equal("the paste", TranscriptPrompts.Prompt(UserLine("\"\\n<pasted_content id=\\\"d441\\\">\\nthe paste\\n</pasted_content id=\\\"d441\\\">\""))?.Text);
    }

    [Theory]
    [InlineData("""[{"type":"tool_result","content":"ok"}]""", "")]
    [InlineData("\"<command-name>/compact</command-name>\"", "")]
    [InlineData("\"<bash-input>dir</bash-input>\"", "")]
    [InlineData("\"<local-command-stdout>done</local-command-stdout>\"", "")]
    [InlineData("""[{"type":"text","text":"[Request interrupted by user]"}]""", "")]
    [InlineData("\"   \"", "")]
    [InlineData("\"a summary\"", ",\"isCompactSummary\":true")]
    [InlineData("\"a notice\"", ",\"isMeta\":true")]
    [InlineData("\"a subagent's task\"", ",\"isSidechain\":true")]
    public void What_the_user_did_not_type_is_left_out(string content, string extra) =>
        Assert.Null(TranscriptPrompts.Prompt(UserLine(content, extra)));

    [Fact]
    public void Replies_and_broken_lines_are_not_prompts()
    {
        Assert.Null(TranscriptPrompts.Prompt($$"""{"type":"assistant","message":{"content":"hi"},"timestamp":"{{At}}"}"""));
        Assert.Null(TranscriptPrompts.Prompt("""{"type":"user","message":{"cont"""));
    }

    [Fact]
    public void A_transcript_gives_its_prompts_in_order_and_a_long_one_is_cut()
    {
        var path = Path.GetTempFileName();
        try
        {
            var lines = new[]
            {
                UserLine("\"first\""),
                $$"""{"type":"assistant","message":{"content":[{"type":"text","text":"ok"}]},"timestamp":"{{At}}"}""",
                UserLine("""[{"type":"tool_result","content":"x"}]"""),
                UserLine($"\"{new string('a', TranscriptPrompts.MaxText + 10)}\""),
            };
            File.WriteAllLines(path, lines);

            var prompts = TranscriptPrompts.Read(path);

            Assert.Equal(2, prompts.Count);
            Assert.Equal("first", prompts[0].Text);
            Assert.Equal(TranscriptPrompts.MaxText, prompts[1].Text.Length);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void A_missing_transcript_has_no_prompts() =>
        Assert.Empty(TranscriptPrompts.Read(Path.Combine(Path.GetTempPath(), Guid.NewGuid() + ".jsonl")));
}

/// <summary>
/// Termilly's own record of prompts (PromptHistory), and how My prompts merges it with the transcripts: each session
/// from one source, so no prompt shows twice.
/// </summary>
public sealed class PromptHistoryTests : IDisposable
{
    private const int Days = 30;
    private const string Pane = "t1";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly Termilly.Desktop.Security.Vault _vault;
    private readonly PromptHistory _history;

    public PromptHistoryTests()
    {
        _vault = Termilly.Desktop.Security.Vault.Open(_dir);
        _history = new PromptHistory(_vault);
    }

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Transcript(string name, params (string Uuid, string Text, string At)[] prompts)
    {
        var path = Path.Combine(_dir, name + ".jsonl");
        File.WriteAllLines(path, prompts.Select(p =>
            $$"""{"type":"user","uuid":"{{p.Uuid}}","message":{"role":"user","content":"{{p.Text}}"},"timestamp":"{{p.At}}"}"""));
        return path;
    }

    [Fact]
    public void Prompts_are_kept_per_terminal_redacted_and_survive_a_restart()
    {
        _history.Add(Pane, "s1", "deploy with token ghp_abcdefghijklmnopqrstuvwxyz0123456789", redact: true, Days);
        _history.Add("t2", "s2", "another terminal", redact: true, Days);

        var kept = new PromptHistory(_vault).Of(Pane, Days);

        Assert.Single(kept);
        Assert.DoesNotContain("ghp_", kept[0].Text, StringComparison.Ordinal);
        Assert.Equal("s1", kept[0].Session);
    }

    [Fact]
    public void Old_prompts_go_with_history_and_clear_empties_it()
    {
        _history.Add(Pane, "s1", "long ago", redact: false, Days, DateTimeOffset.UtcNow.AddDays(-Days - 1));
        _history.Add(Pane, "s1", "today", redact: false, Days);

        Assert.Equal(["today"], _history.Of(Pane, Days).Select(p => p.Text));
        _history.Clear();
        Assert.Empty(new PromptHistory(_vault).Of(Pane, Days));
    }

    [Fact]
    public void A_session_with_a_transcript_takes_it_and_its_recorded_prompts_are_not_shown_again()
    {
        var transcript = Transcript("s1", ("u1", "fix the build", "2026-11-01T10:00:00.000Z"), ("u2", "now the tests", "2026-11-01T10:05:00.000Z"));
        StoredPrompt[] stored =
        [
            new(Pane, "s1", "fix the build", "2026-11-01T10:00:00.010Z"),
            new(Pane, "s1", "now the tests", "2026-11-01T10:05:00.020Z"),
            // Its transcript was deleted (Claude Code keeps them 30 days): only the record has these.
            new(Pane, "s0", "an old question", "2026-09-01T09:00:00.000Z"),
            // Sent on another machine, no session known.
            new(Pane, null, "on the server", "2026-11-01T11:00:00.000Z"),
        ];

        var merged = PromptsHandler.Merge(["s1"], s => s == "s1" ? transcript : null, stored);

        Assert.Equal(["an old question", "fix the build", "now the tests", "on the server"], merged.Select(p => p.Text));
    }

    [Fact]
    public void A_prompt_copied_into_a_resumed_sessions_transcript_shows_once_but_a_prompt_sent_twice_shows_twice()
    {
        var first = Transcript("s1", ("u1", "start", "2026-11-01T10:00:00.000Z"));
        var resumed = Transcript("s2", ("u1", "start", "2026-11-01T10:00:00.000Z"), ("u2", "yes", "2026-11-01T10:01:00.000Z"), ("u3", "yes", "2026-11-01T10:02:00.000Z"));

        var merged = PromptsHandler.Merge(["s1", "s2"], s => s == "s1" ? first : s == "s2" ? resumed : null, []);

        Assert.Equal(["start", "yes", "yes"], merged.Select(p => p.Text));
    }

    [Fact]
    public void Another_computers_answer_carries_claudes_replies_and_tool_calls()
    {
        var answer = (System.Text.Json.Nodes.JsonObject)System.Text.Json.Nodes.JsonNode.Parse("""
            {"prompts":[{"text":"fix it","at":"2026-11-01T10:00:00.000Z"}],"steps":[
              {"kind":"tool","text":"dotnet build","at":"2026-11-01T10:00:05.000Z","tool":"Bash","failed":true},
              {"kind":"reply","text":"Fixed.","at":"2026-11-01T10:00:09.000Z","tool":null,"failed":false},
              {"kind":"other","text":"x","at":"2026-11-01T10:00:10.000Z"}]}
            """)!;

        var steps = Phone.PcPromptsApi.ReadSteps(answer);

        Assert.Equal(
            [new Messaging.AgentStep("tool", "dotnet build", "2026-11-01T10:00:05.000Z", "Bash", true), new Messaging.AgentStep("reply", "Fixed.", "2026-11-01T10:00:09.000Z")],
            steps);
        Assert.Empty(Phone.PcPromptsApi.ReadSteps([])); // an older Termilly sends none
    }
}
