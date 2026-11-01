namespace Termilly.Desktop.Messaging;

// My prompts (js/myprompts.js): what the user asked Claude Code in a terminal, read from its sessions' transcripts
// (Features/Prompts.cs).

internal static partial class FromPage
{
    /// <summary>The prompts of a terminal's Claude Code sessions (their ids, oldest first).</summary>
    internal sealed record PromptsList(string? RequestId = null, IReadOnlyList<string>? Sessions = null) : IPageMessage
    {
        public static string Type => "prompts:list";
    }
}

/// <summary>A prompt the user sent: its text and when (ISO 8601).</summary>
internal sealed record AgentPrompt(string Text, string At);

internal static partial class ToPage
{
    /// <summary>A terminal's prompts, oldest first.</summary>
    internal sealed record PromptsListed(string? RequestId, IReadOnlyList<AgentPrompt> Prompts) : IHostMessage
    {
        public static string Type => "prompts:listed";
    }
}
