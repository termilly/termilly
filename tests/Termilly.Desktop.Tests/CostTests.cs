extern alias agent;

using agent::Termilly.Agent;

namespace Termilly.Desktop.Tests;

public sealed class CostTests
{
    [Theory]
    [InlineData("claude-opus-5-5", 1_000_000, 0, 0, 1_000_000, 24.0)]
    [InlineData("claude-sonnet-5-5[1m]", 2_000_000, 0, 1_000_000, 100_000, 5.2)]
    [InlineData("claude-haiku-5-5", 1_000_000, 1_000_000, 0, 0, 0.225)]
    [InlineData("claude-opus-4-8", 0, 0, 0, 1_000_000, 25.0)]
    [InlineData("claude-fable-5-1", 0, 0, 1_000_000, 0, 0.25)]
    public void Tokens_are_priced_by_model(string model, long input, long write, long read, long output, double usd)
    {
        Assert.Equal(usd, Pricing.Estimate(model, input, write, read, output)!.Value, 6);
    }

    [Fact]
    public void An_unknown_model_has_no_estimate()
    {
        Assert.Null(Pricing.Estimate("gpt-5", 1000, 0, 0, 1000));
        Assert.Null(Pricing.Estimate(null, 1000, 0, 0, 1000));
    }

    [Fact]
    public void Claudes_own_cost_comes_through_the_status_line()
    {
        var input = """{ "session_id": "s1", "cost": { "total_cost_usd": 1.8432, "total_duration_ms": 125000, "total_lines_added": 40 }, "workspace": { "current_dir": "C:/secret" } }""";

        var line = StatusLine.Message("p1", input);
        var e = AgentHooks.Parse(line)!;

        Assert.Equal(new ClaudeCost(1.8432, 125000.0), e.Status!.Cost);
        Assert.DoesNotContain("secret", line);
    }

    [Fact]
    public void A_stopped_subagent_passes_its_transcript_path()
    {
        var stop = """{"session_id":"s","agent_id":"a1","agent_type":"Explore","agent_transcript_path":"C:/u/.claude/projects/p/s/subagents/agent-a1.jsonl","last_assistant_message":"ok"}""";

        var e = AgentHooks.Parse(Protocol.Message("p", "SubagentStop", stop))!;

        Assert.EndsWith("agent-a1.jsonl", e.Subagent!.Transcript);
        Assert.Null(AgentHooks.Parse(Protocol.Message("p", "PreToolUse", """{"agent_id":"a1","agent_transcript_path":"C:/t.jsonl"}"""))!.Subagent!.Transcript);
    }
}
