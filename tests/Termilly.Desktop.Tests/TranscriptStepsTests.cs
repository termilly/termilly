using System.IO;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Tests;

/// <summary>What Claude did between prompts (Features/TranscriptSteps.cs): its replies and tools, out of a transcript.</summary>
public sealed class TranscriptStepsTests
{
    private const string At = "2026-11-03T09:15:00.000Z";
    private const string Later = "2026-11-03T09:16:00.000Z";

    private static string Assistant(string blocks, string at = At, string extra = "") =>
        $$"""{"type":"assistant"{{extra}},"uuid":"u-{{at}}-{{blocks.Length}}","message":{"role":"assistant","content":[{{blocks}}]},"timestamp":"{{at}}"}""";

    private static List<AgentStep> StepsOf(params string[] lines)
    {
        var path = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(path, lines);
            return TranscriptSteps.ReadKeyed(path).Select(s => s.Step).ToList();
        }
        finally
        {
            File.Delete(path);
        }
    }

    [Fact]
    public void Replies_and_tools_are_read_in_order_with_what_a_tool_was_used_on()
    {
        var steps = StepsOf(
            Assistant("""{"type":"text","text":"I'll check the tests."},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm test\n-- webhooks","description":"run"}}"""),
            Assistant("""{"type":"tool_use","id":"t2","name":"Edit","input":{"file_path":"src/sign.ts","old_string":"a"}}"""),
            Assistant("""{"type":"thinking","thinking":"hmm"},{"type":"text","text":"  Fixed.  "}""", Later));

        Assert.Equal(4, steps.Count);
        Assert.Equal(new AgentStep(AgentStepKind.Reply, "I'll check the tests.", At), steps[0]);
        Assert.Equal(new AgentStep(AgentStepKind.Tool, "npm test -- webhooks", At, "Bash"), steps[1]);
        Assert.Equal(new AgentStep(AgentStepKind.Tool, "src/sign.ts", At, "Edit"), steps[2]);
        Assert.Equal(new AgentStep(AgentStepKind.Reply, "Fixed.", Later), steps[3]);
    }

    [Fact]
    public void A_tool_whose_result_was_an_error_is_marked_failed()
    {
        var steps = StepsOf(
            Assistant("""{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm run build"}}"""),
            """{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","is_error":true,"content":"exit 1"}]},"timestamp":"2026-11-03T09:15:01.000Z"}""",
            Assistant("""{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"a.ts"}}"""));

        Assert.True(steps[0].Failed);
        Assert.False(steps[1].Failed);
    }

    [Fact]
    public void A_subagents_steps_prompts_and_broken_lines_are_left_out()
    {
        var steps = StepsOf(
            Assistant("""{"type":"text","text":"from a subagent"}""", extra: ",\"isSidechain\":true"),
            """{"type":"user","message":{"role":"user","content":"fix it"},"timestamp":"2026-11-03T09:15:00.000Z"}""",
            """{"type":"assistant","message":{"cont""");

        Assert.Empty(steps);
    }

    [Fact]
    public void Steps_in_two_transcripts_show_once_and_sort_by_time()
    {
        var first = Path.GetTempFileName();
        var second = Path.GetTempFileName();
        try
        {
            var shared = Assistant("""{"type":"text","text":"shared"}""");
            File.WriteAllLines(first, [shared]);
            File.WriteAllLines(second, [Assistant("""{"type":"text","text":"newer"}""", Later), shared]);
            var steps = PromptsHandler.Steps(["a", "b"], s => s == "a" ? first : second);

            Assert.Equal(["shared", "newer"], steps.Select(s => s.Text));
        }
        finally
        {
            File.Delete(first);
            File.Delete(second);
        }
    }
}
