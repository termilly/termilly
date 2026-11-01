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
