using System.IO;
using System.Text;
using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The plans' usage limits asked for directly, so the status bar shows them before (and between) an agent's replies:
/// Codex's from its app server (account/rateLimits/read, no model call, free), Claude's from the smallest prompt
/// Claude Code can be sent (Haiku, no tools, no session kept, none of the user's settings or hooks), whose answer
/// carries them. The page asks (limits:refresh) while Termilly is in front and the figures are old.
/// </summary>
internal sealed class PlanRefreshHandler(PageChannel page, IProcessRunner runner, ISettingsStore settings, AgentMonitor agents) : IMessageHandler
{
    private static readonly TimeSpan CodexTimeout = TimeSpan.FromSeconds(20);
    private static readonly TimeSpan ClaudeTimeout = TimeSpan.FromSeconds(60);
    private int _running;

    public void Register(MessageRouter router) =>
        router.On<FromPage.LimitsRefresh>(m => Task.Run(() => RefreshAsync(m.Agent)));

    private async Task RefreshAsync(string? agent)
    {
        var s = settings.Current.Agents;
        var wanted = agent == AgentKinds.Codex ? s.CodexUsage : s.ClaudeUsage;
        // One at a time: the page asks again only once figures are old, but a slow answer shouldn't pile up runs.
        if (!(s.Integration && s.ClaudeLimits && s.RefreshLimits && wanted) || Interlocked.Exchange(ref _running, 1) == 1)
        {
            return;
        }
        try
        {
            if (agent == AgentKinds.Codex)
            {
                await RefreshCodexAsync().ConfigureAwait(false);
            }
            else
            {
                await RefreshClaudeAsync().ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is IOException or ProcessTimeoutException or ProgramMissingException or JsonException)
        {
            // Not this time: the figures stay as they were, and the page asks again later.
        }
        finally
        {
            Volatile.Write(ref _running, 0);
        }
    }

    private async Task RefreshCodexAsync()
    {
        if (SessionProfiles.FindAgent(AgentKinds.Codex) is not { } codex)
        {
            return;
        }
        var result = await runner.RunAsync(new ProcessRequest(codex, [PlanLimitReaders.CodexAppServer])
        {
            Input = PlanLimitReaders.CodexRequest,
            DoneWhen = PlanLimitReaders.CodexAnswered,
            Timeout = CodexTimeout,
            WorkingDirectory = Path.GetTempPath(),
        }).ConfigureAwait(false);
        if (PlanLimitReaders.Codex(result.Text) is { } limits)
        {
            page.Post(new ToPage.CodexLimitsReport(limits.FiveHour, limits.SevenDay));
        }
    }

    private async Task RefreshClaudeAsync()
    {
        if (SessionProfiles.FindAgent(AgentKinds.Claude) is not { } claude)
        {
            return;
        }
        var result = await runner.RunAsync(new ProcessRequest(claude, PlanLimitReaders.ClaudePing)
        {
            Timeout = ClaudeTimeout,
            WorkingDirectory = Path.GetTempPath(),
        }).ConfigureAwait(false);
        if (PlanLimitReaders.Claude(result.Text) is { } limits)
        {
            page.Post(new ToPage.LimitsReport(limits.FiveHour, limits.SevenDay));
            agents.RefreshPlan();
        }
    }
}

/// <summary>What the plan refresh asks the agents, and how their answers are read.</summary>
internal static class PlanLimitReaders
{
    public const string CodexAppServer = "app-server";
    private const long FiveHourMinutes = 5 * 60;
    private const long WeekMinutes = 7 * 24 * 60;
    private const double MaxPercent = 100;
    private const string ClaudeLimitEvent = "rate_limit_event";
    private const int AnswerId = 2;

    /// <summary>The app server's JSON-RPC, a message a line: introduce, then ask for the limits (id 2).</summary>
    public static readonly string CodexRequest =
        """{"id":1,"method":"initialize","params":{"clientInfo":{"name":"termilly","version":"1"}}}""" + "\n"
        + """{"method":"initialized"}""" + "\n"
        + $$"""{"id":{{AnswerId}},"method":"account/rateLimits/read"}""" + "\n";

    private static readonly byte[] AnswerMark = Encoding.UTF8.GetBytes($"\"id\":{AnswerId},");

    /// <summary>The app server answered the limits (it then waits for more, so it's ended).</summary>
    public static bool CodexAnswered(byte[] output) => output.AsSpan().IndexOf(AnswerMark) >= 0 && output[^1] == '\n';

    /// <summary>
    /// The smallest prompt: Haiku, a two-letter answer, no tools, no session kept, and none of the user's settings,
    /// so none of their hooks (a sound, a notification) run for it. Its stream says the limits.
    /// </summary>
    public static readonly IReadOnlyList<string> ClaudePing =
        ["-p", "ok", "--model", "haiku", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
         "--max-turns", "1", "--tools", "", "--setting-sources", ""];

    /// <summary>Codex's limits from the app server's answer: its windows told apart by their length.</summary>
    public static PlanLimits? Codex(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            using var doc = TryParse(line);
            if (doc?.RootElement is not { ValueKind: JsonValueKind.Object } root || Json.Num(root, Fields.Id) != AnswerId
                || !root.TryGetProperty(Fields.Result, out var result) || !result.TryGetProperty(Fields.RateLimits, out var rates))
            {
                continue;
            }
            PlanWindow? five = null, week = null;
            foreach (var name in (string[])[Fields.Primary, Fields.Secondary])
            {
                if (rates.TryGetProperty(name, out var w) && w.ValueKind == JsonValueKind.Object && w.TryGetProperty(Fields.UsedPercent, out var used) && used.ValueKind == JsonValueKind.Number)
                {
                    var window = new PlanWindow(Math.Clamp(used.GetDouble(), 0, MaxPercent), Json.Num(w, Fields.ResetsAt) is > 0 and var at ? at : null);
                    switch (Json.Num(w, Fields.WindowMinutes))
                    {
                        case FiveHourMinutes: five = window; break;
                        case WeekMinutes: week = window; break;
                    }
                }
            }
            return new PlanLimits(five, week);
        }
        return null;
    }

    /// <summary>Claude's limits from its stream's rate limit event: each window's use (0 to 1) and when it resets.</summary>
    public static PlanLimits? Claude(string output)
    {
        foreach (var line in output.Split('\n'))
        {
            using var doc = TryParse(line);
            if (doc?.RootElement is not { ValueKind: JsonValueKind.Object } root || Json.Str(root, Fields.Type) != ClaudeLimitEvent
                || !root.TryGetProperty(Fields.RateLimitInfo, out var info) || !info.TryGetProperty(Fields.Windows, out var windows))
            {
                continue;
            }
            return new PlanLimits(Window(windows, Fields.FiveHour), Window(windows, Fields.SevenDay));
        }
        return null;
    }

    private static PlanWindow? Window(JsonElement windows, string name) =>
        windows.TryGetProperty(name, out var w) && w.ValueKind == JsonValueKind.Object && w.TryGetProperty(Fields.Utilization, out var u) && u.ValueKind == JsonValueKind.Number
            ? new PlanWindow(Math.Clamp(u.GetDouble() * MaxPercent, 0, MaxPercent), Json.Num(w, Fields.ResetsAt) is > 0 and var at ? at : null)
            : null;

    private static JsonDocument? TryParse(string line)
    {
        try
        {
            return line.TrimStart().StartsWith('{') ? JsonDocument.Parse(line) : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static class Fields
    {
        public const string Id = "id";
        public const string Type = "type";
        public const string Result = "result";
        public const string RateLimits = "rateLimits";
        public const string Primary = "primary";
        public const string Secondary = "secondary";
        public const string UsedPercent = "usedPercent";
        public const string WindowMinutes = "windowDurationMins";
        public const string ResetsAt = "resetsAt";
        public const string RateLimitInfo = "rate_limit_info";
        public const string Windows = "unifiedWindows";
        public const string FiveHour = "five_hour";
        public const string SevenDay = "seven_day";
        public const string Utilization = "utilization";
    }
}
