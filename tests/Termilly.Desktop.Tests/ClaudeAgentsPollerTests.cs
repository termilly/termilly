namespace Termilly.Desktop.Tests;

public sealed class ClaudeAgentsPollerTests
{
    [Fact]
    public void Agents_json_is_read_and_incomplete_entries_skipped()
    {
        var agents = ClaudeAgentsPoller.ParseAgents("""
            [
              {"pid":28280,"cwd":"C:\\p","kind":"interactive","sessionId":"s1","name":"proj","status":"waiting","waitingFor":"permission prompt"},
              {"pid":10700,"kind":"background","sessionId":"s2","status":"busy","state":"working"},
              {"kind":"interactive","sessionId":"no-pid","status":"idle"},
              {"pid":5,"status":"idle"},
              "junk"
            ]
            """);

        Assert.Equal([new ClaudeAgent(28280, "s1", "waiting", "permission prompt"), new ClaudeAgent(10700, "s2", "busy", null)], agents);
        Assert.Empty(ClaudeAgentsPoller.ParseAgents("{}"));
    }

    [Theory]
    [InlineData(null, "idle", "idle")]
    [InlineData(null, "busy", "working")]
    [InlineData("idle", "waiting", "needs-input")]
    [InlineData("working", "idle", "done")]
    [InlineData("needs-input", "idle", "done")]
    [InlineData("done", "idle", "done")]
    [InlineData("working", "sleeping", null)]
    public void Status_becomes_an_agent_state(string? before, string status, string? expected) =>
        Assert.Equal(expected, ClaudeAgentsPoller.NextState(before, status));

    [Fact]
    public void Sessions_belong_to_the_terminal_whose_processes_include_them()
    {
        // Terminal a: pwsh 100 → claude shim 200 → claude 300. Terminal b: cmd 400. 900 is elsewhere.
        List<ProcessEntry> all =
        [
            new(100, 1, "pwsh.exe"), new(101, 100, "OpenConsole.exe"), new(200, 100, "claude.exe"), new(300, 200, "claude.exe"),
            new(400, 1, "cmd.exe"), new(900, 1, "claude.exe"),
        ];
        var terminals = new Dictionary<string, HashSet<int>>
        {
            ["a"] = ClaudeAgentsPoller.Descendants(all, 100).Select(p => p.Id).ToHashSet(),
            ["b"] = ClaudeAgentsPoller.Descendants(all, 400).Select(p => p.Id).ToHashSet(),
        };

        var matched = ClaudeAgentsPoller.Match(terminals, [new ClaudeAgent(300, "s", "busy", null), new ClaudeAgent(900, "x", "busy", null)]).ToList();

        Assert.Equal([101, 200, 300], terminals["a"].Order());
        Assert.Equal(("a", "s"), (matched.Single().Terminal, matched.Single().Agent.SessionId));
    }

    [Fact]
    public void Descendants_survive_a_parent_loop_from_reused_ids() =>
        Assert.Equal([200], ClaudeAgentsPoller.Descendants([new(200, 100, "a.exe"), new(100, 200, "b.exe")], 100).Select(p => p.Id));
}
