using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Messaging;

// Coding agents (Claude Code): their state from hooks or `claude agents`, subagents, usage, cost and limits; hooks
// reported from servers; and the page's answers to what the host asks it for the API.

/// <summary>Where an agent state came from: Claude Code's hooks, or polling `claude agents` for unhooked ones.</summary>
internal static class AgentSources
{
    public const string Hooks = "hooks";
    public const string Poll = "poll";
    /// <summary>Set by the page, not an agent: an output alert or a trigger (AgentStates.Attention).</summary>
    public const string Alert = "alert";
}

internal static partial class FromPage
{
    /// <summary>Claude Code's hook on a server, reported through the terminal (shell/remote/termilly-hook.sh).</summary>
    /// <param name="Payload">The hook's JSON, base64.</param>
    internal sealed record RemoteHook(string Id = "", string? Event = null, string? Payload = null) : IPageMessage
    {
        public static string Type => "remote:hook";
    }

    /// <summary>"Set up Termilly on this host": the page wants the line to type and the installer it reads.</summary>
    internal sealed record RemoteInstall(string Id = "") : IPageMessage
    {
        public static string Type => "remote:install";
    }

    internal sealed record RemoteRemove(string Id = "") : IPageMessage
    {
        public static string Type => "remote:remove";
    }

    /// <summary>The page's answer to what the host asked it (<see cref="ToPage.PageCall"/>): a result, or an error.</summary>
    internal sealed record ApiResult(string? RequestId = null, JsonElement? Result = null, string? Error = null) : IPageMessage
    {
        public static string Type => "api:result";
    }
}

internal static partial class ToPage
{
    /// <summary>An agent's state from polling `claude agents` (no hooks in that terminal).</summary>
    internal sealed record PolledAgent(string Id, string State, string? Message, string? Session) : IHostMessage
    {
        public static string Type => "agent";

        public string Source { get; } = AgentSources.Poll;
    }

    /// <summary>
    /// An agent's state from one of its hooks; <see cref="Target"/> is the file or command it works on, and
    /// <see cref="Folder"/> (SessionStart) the folder its session belongs to, where it resumes.
    /// </summary>
    internal sealed record HookedAgent(
        string Id, string State, string Event, string? Tool, string? Message, string? Reason, string? Session, string? Target,
        string? Folder) : IHostMessage
    {
        public static string Type => "agent";

        public string Source { get; } = AgentSources.Hooks;
    }

    /// <summary>A subagent's row under its terminal (js/subagents.js): an Agent call, its start and stop, its tools.</summary>
    internal sealed record SubagentRow(
        string Id, string Event, string? AgentId, string? AgentType, string? ToolUseId, string? Description, string? SubagentType,
        bool Background, string? LaunchedId, string? Tool, string? Target, string? Message, string? Session) : IHostMessage
    {
        public static string Type => "subagent";
    }

    /// <summary>A finished subagent's tokens, priced (Pricing.cs).</summary>
    internal sealed record SubagentCost(string Id, string AgentId, double? Usd, string? Model, long Input, long Output) : IHostMessage
    {
        public static string Type => "subagent:cost";
    }

    internal sealed record UsageReport(string Id, ClaudeUsage Usage) : IHostMessage
    {
        public static string Type => "claude:usage";
    }

    /// <summary>The account's plan limits (not the terminal's): the page shows them on every Claude terminal.</summary>
    internal sealed record LimitsReport(PlanWindow? FiveHour, PlanWindow? SevenDay) : IHostMessage
    {
        public static string Type => "claude:limits";
    }

    internal sealed record PlanReport(string? Subscription, string? AuthMethod) : IHostMessage
    {
        public static string Type => "claude:plan";
    }

    /// <summary>Claude's own cost for the session (its status line).</summary>
    internal sealed record CostReport(string Id, string? Session, double Usd, double? DurationMs) : IHostMessage
    {
        public static string Type => "claude:cost";
    }

    /// <summary>Claude Code's own context figures for this terminal's session; the page prefers them to the transcript's.</summary>
    internal sealed record ContextReport(string Id, string? Session, double Used, long Size, long? Tokens) : IHostMessage
    {
        public static string Type => "claude:context";
    }

    /// <summary>The line to type on a server, and the installer it then reads (js/remotehost.js).</summary>
    internal sealed record RemoteInstall(string Id, string Command, string Payload) : IHostMessage
    {
        public static string Type => "remote:install";
    }

    internal sealed record RemoteInstallFailed(string Id, string Error) : IHostMessage
    {
        public static string Type => "remote:install";
    }

    internal sealed record RemoteRemove(string Id, string Command) : IHostMessage
    {
        public static string Type => "remote:remove";
    }

    /// <summary>
    /// What the host asks the page, answered with api:result: the termilly command's and MCP server's requests
    /// ("api"). <see cref="Fields"/> go into the message as they are, beside its type and request id.
    /// </summary>
    internal sealed record PageCall(string Type, string RequestId, JsonObject Fields)
    {
        private const string RequestIdProperty = "requestId";

        public string Json()
        {
            var message = new JsonObject { [HostMessage.TypeProperty] = Type, [RequestIdProperty] = RequestId };
            foreach (var (name, value) in Fields)
            {
                message[name] = value?.DeepClone();
            }
            return message.ToJsonString();
        }
    }

    /// <summary>The names of what the host asks the page (<see cref="PageCall"/>).</summary>
    internal static class Calls
    {
        public const string Api = "api";

        public static readonly string[] All = [Api];
    }
}
