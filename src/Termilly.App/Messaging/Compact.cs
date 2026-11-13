namespace Termilly.Desktop.Messaging;

// The compact view of an agent terminal (js/compact.js): its session file (Claude Code's transcript, Codex's rollout)
// read as one line per step (Features/CompactFeed.cs).

internal static partial class FromPage
{
    /// <summary>
    /// Follow this session in this terminal's compact view, and send what it holds so far; no session stops following.
    /// <see cref="Agent"/> is the agent's kind (AgentKinds), which says what kind of file to read.
    /// </summary>
    internal sealed record CompactWatch(string Id = "", string? Session = null, string? Agent = null) : IPageMessage
    {
        public static string Type => "compact:watch";
    }
}

/// <summary>
/// One line of the compact view. <see cref="Key"/> tells it apart within its session: a line sent again with the same key
/// replaces it (a tool's result arrived). <see cref="Text"/> is the words (a prompt, a reply, thinking) or what a tool
/// worked on; <see cref="Detail"/> what came of it ("12 hits", "+9 -2", "41 passed"). A question the agent asks the
/// user (Claude Code's AskUserQuestion) carries its <see cref="Questions"/>, and a plan up for approval (ExitPlanMode)
/// the plan as <see cref="Body"/>, for the view's card.
/// </summary>
internal sealed record CompactLine(string Key, string Kind, string Text, string? Verb = null, string? Detail = null, bool Failed = false, bool Done = true, IReadOnlyList<CompactQuestion>? Questions = null, string? Body = null);

/// <summary>A question the agent asks the user, with its choices (one, or several with <see cref="Multi"/>).</summary>
internal sealed record CompactQuestion(string Question, string? Header, bool Multi, IReadOnlyList<CompactOption> Options);

/// <summary>A choice of a <see cref="CompactQuestion"/>.</summary>
internal sealed record CompactOption(string Label, string? Description);

/// <summary>The kinds of <see cref="CompactLine"/>.</summary>
internal static class CompactKinds
{
    /// <summary>What the user asked: a turn starts.</summary>
    public const string Prompt = "prompt";
    /// <summary>The agent's words.</summary>
    public const string Reply = "reply";
    /// <summary>The agent's thinking (a summary of it, for Codex).</summary>
    public const string Thinking = "thinking";
    /// <summary>A tool the agent used (<see cref="CompactLine.Verb"/> says which kind).</summary>
    public const string Tool = "tool";
    /// <summary>The turn ended: how long it took (<see cref="CompactLine.Detail"/>).</summary>
    public const string End = "end";
    /// <summary>The user stopped the turn.</summary>
    public const string Interrupted = "interrupted";
    public static readonly IReadOnlyList<string> All = [Prompt, Reply, Thinking, Tool, End, Interrupted];
}

/// <summary>How much of a session the compact view keeps, the host and the page alike.</summary>
internal static class CompactLimits
{
    /// <summary>The newest this many lines; older ones go.</summary>
    public const int MaxLines = 2000;
}

/// <summary>What a tool line says the agent did, the same words for Claude Code and Codex.</summary>
internal static class CompactVerbs
{
    public const string Search = "Search";
    public const string Read = "Read";
    public const string List = "List";
    public const string Edit = "Edit";
    public const string Write = "Write";
    public const string Run = "Run";
    public const string Test = "Test";
    public const string Web = "Web";
    public const string Agent = "Agent";
    public const string Plan = "Plan";
    public const string Ask = "Ask";
    public const string Mcp = "MCP";
    public const string Tool = "Tool";
    public static readonly IReadOnlyList<string> All = [Search, Read, List, Edit, Write, Run, Test, Web, Agent, Plan, Ask, Mcp, Tool];
}

internal static partial class ToPage
{
    /// <summary>
    /// A terminal's compact view: the lines of its session that are new or changed, oldest first; with
    /// <see cref="Reset"/>, every line it has (the view starts over, after a watch or a new session).
    /// </summary>
    internal sealed record CompactLines(string Id, string Session, IReadOnlyList<CompactLine> Lines, bool Reset) : IHostMessage
    {
        public static string Type => "compact:lines";
    }
}
