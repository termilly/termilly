namespace Termilly.Desktop.Messaging;

// My prompts (js/myprompts.js): what the user asked Claude Code in a terminal, from Termilly's own record and its
// sessions' transcripts (Features/Prompts.cs).

internal static partial class FromPage
{
    /// <summary>A terminal's prompts: Termilly's record of them, and its Claude Code sessions' (their ids, oldest first).</summary>
    internal sealed record PromptsList(string? RequestId = null, string? Id = null, IReadOnlyList<string>? Sessions = null) : IPageMessage
    {
        public static string Type => "prompts:list";
    }

    /// <summary>The prompts of another Termilly computer's terminal shown here (<see cref="Tab"/>), from that computer.</summary>
    internal sealed record PcPrompts(string? RequestId = null, string Tab = "") : IPageMessage
    {
        public static string Type => "pc:prompts";
    }

    /// <summary>A prompt sent in a terminal that keeps history, to keep (PromptHistory).</summary>
    internal sealed record PromptAdd(string Id = "", string? Session = null, string? Text = null) : IPageMessage
    {
        public static string Type => "prompt:add";
    }
}

/// <summary>A prompt the user sent: its text and when (ISO 8601).</summary>
internal sealed record AgentPrompt(string Text, string At);

/// <summary>
/// What Claude did after a prompt (Features/TranscriptSteps.cs): a reply it wrote (<see cref="Text"/>), or a tool it used
/// (<see cref="Tool"/>, and in <see cref="Text"/> what on: a command, a file, a pattern), and whether that failed.
/// </summary>
internal sealed record AgentStep(string Kind, string Text, string At, string? Tool = null, bool Failed = false);

/// <summary>The kinds of <see cref="AgentStep"/>.</summary>
internal static class AgentStepKind
{
    public const string Reply = "reply";
    public const string Tool = "tool";
    public static readonly IReadOnlyList<string> All = [Reply, Tool];
}

internal static partial class ToPage
{
    /// <summary>
    /// A terminal's prompts, oldest first, and what Claude did between them (its replies and tools, from the
    /// transcripts on this PC); for another computer's terminal, why they couldn't be had.
    /// </summary>
    internal sealed record PromptsListed(string? RequestId, IReadOnlyList<AgentPrompt> Prompts, string? Error = null, IReadOnlyList<AgentStep>? Steps = null) : IHostMessage
    {
        public static string Type => "prompts:listed";
    }
}
