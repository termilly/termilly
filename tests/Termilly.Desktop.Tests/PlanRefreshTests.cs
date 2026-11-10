using System.Text;
using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

public sealed class PlanRefreshTests
{
    [Fact]
    public void Codex_app_servers_answer_gives_both_windows()
    {
        const string output = """
            {"id":1,"result":{"userAgent":"x"}}
            {"method":"account/rateLimits/updated","params":{}}
            {"id":2,"result":{"rateLimits":{"primary":{"usedPercent":13,"windowDurationMins":300,"resetsAt":1794275366},"secondary":{"usedPercent":5,"windowDurationMins":10080,"resetsAt":1794821462},"planType":"plus"}}}
            """;
        var limits = PlanLimitReaders.Codex(output)!;
        Assert.Equal(new PlanWindow(13, 1794275366), limits.FiveHour);
        Assert.Equal(new PlanWindow(5, 1794821462), limits.SevenDay);
        Assert.Null(PlanLimitReaders.Codex("""{"id":2,"error":{"message":"not signed in"}}"""));
    }

    [Fact]
    public void The_app_server_is_done_once_its_answer_line_is_whole()
    {
        Assert.False(PlanLimitReaders.CodexAnswered(Encoding.UTF8.GetBytes("{\"id\":1,\"result\":{}}\n")));
        Assert.False(PlanLimitReaders.CodexAnswered(Encoding.UTF8.GetBytes("{\"id\":2,\"result\":{\"rateLim")));
        Assert.True(PlanLimitReaders.CodexAnswered(Encoding.UTF8.GetBytes("{\"id\":2,\"result\":{}}\n")));
        Assert.EndsWith("\n", PlanLimitReaders.CodexRequest, StringComparison.Ordinal);
        Assert.Contains("account/rateLimits/read", PlanLimitReaders.CodexRequest, StringComparison.Ordinal);
    }

    [Fact]
    public void Claudes_stream_gives_both_windows_in_percent()
    {
        const string output = """
            {"type":"system","subtype":"init"}
            {"type":"rate_limit_event","rate_limit_info":{"status":"allowed","unifiedWindows":{"five_hour":{"utilization":0.57,"resetsAt":1794279600},"seven_day":{"utilization":0.16,"resetsAt":1794787200}}}}
            {"type":"result","subtype":"success"}
            """;
        var limits = PlanLimitReaders.Claude(output)!;
        Assert.Equal(57, limits.FiveHour!.Used, 3);
        Assert.Equal(1794279600L, limits.FiveHour.ResetsAt);
        Assert.Equal(16, limits.SevenDay!.Used, 3);
        Assert.Null(PlanLimitReaders.Claude("not json\n{\"type\":\"result\"}"));
    }

    [Fact]
    public void Claudes_ping_is_the_smallest_prompt_and_loads_none_of_the_users_settings()
    {
        var args = PlanLimitReaders.ClaudePing;
        Assert.Equal("haiku", args[args.ToList().IndexOf("--model") + 1]);
        Assert.Equal("", args[args.ToList().IndexOf("--setting-sources") + 1]); // so none of the user's hooks run
        Assert.Contains("--no-session-persistence", args);
    }
}
