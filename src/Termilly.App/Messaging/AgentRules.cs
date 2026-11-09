namespace Termilly.Desktop.Messaging;

// Carrying Claude Code's command rules over to Codex, for a project (AgentRules.cs, Features/AgentRulesHandler.cs, js/agentrules.js).

internal static partial class FromPage
{
    /// <summary>Claude Code's rules that apply in <see cref="Folder"/>, and which of them Codex has a counterpart for.</summary>
    internal sealed record AgentRulesRead(string? Folder = null) : IPageMessage
    {
        public static string Type => "agentRules:read";
    }

    /// <summary>Carries over to Codex's rules the ones the user was shown (<see cref="Rules"/>), if they're still what would be.</summary>
    internal sealed record AgentRulesCopy(string? Folder = null, IReadOnlyList<AgentRuleChoice>? Rules = null) : IPageMessage
    {
        public static string Type => "agentRules:copy";
    }
}

/// <summary>
/// One of Claude Code's rules as the page shows it: its text, Codex's decision for it (allow, prompt, forbidden), the
/// settings it's from, and the command it becomes there, or why it has no counterpart.
/// </summary>
internal sealed record AgentRuleView(string Text, string Decision, string Source, string? Command, string? Why);

/// <summary>A rule the user was shown as one that carries over, and said yes to: its text, decision and command.</summary>
internal sealed record AgentRuleChoice(string Text = "", string Decision = "", string Command = "");

internal static partial class ToPage
{
    /// <summary>
    /// The rules read, the project's file those that carry over go to (none with no project folder), and how many rules
    /// Termilly wrote there before, which a copy replaces.
    /// </summary>
    internal sealed record AgentRulesList(string? Folder, IReadOnlyList<AgentRuleView> Rules, string? File, int Existing) : IHostMessage
    {
        public static string Type => "agentRules:list";
    }

    /// <summary>How many of Termilly's rules the project's file holds after the copy, or why nothing was written.</summary>
    internal sealed record AgentRulesCopied(int Count, string? File, string? Error = null) : IHostMessage
    {
        public static string Type => "agentRules:copied";
    }
}
