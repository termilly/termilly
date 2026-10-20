namespace Termilly.Shared;

/// <summary>
/// The Claude Code hook events Termilly listens to (ClaudeHookSettings adds a hook for each), and the two messages of
/// its own that travel the same way: a status line report and the edit the change preview asks for.
/// </summary>
internal static class HookEvents
{
    public const string SessionStart = "SessionStart";
    public const string UserPromptSubmit = "UserPromptSubmit";
    public const string PreToolUse = "PreToolUse";
    public const string PostToolUse = "PostToolUse";
    public const string PermissionRequest = "PermissionRequest";
    public const string PreCompact = "PreCompact";
    public const string Stop = "Stop";
    public const string StopFailure = "StopFailure";
    public const string SessionEnd = "SessionEnd";
    public const string SubagentStart = "SubagentStart";
    public const string SubagentStop = "SubagentStop";

    /// <summary>Termilly's status line reporting the plan's limits, the context and the cost (Termilly.Agent/StatusLine.cs).</summary>
    public const string StatusLine = "StatusLine";
    /// <summary>Claude's edit itself, sent after PostToolUse when the change preview asks for it.</summary>
    public const string Edit = "Edit";

    /// <summary>The Claude Code events, with whether each is about a tool (a tool event's hook needs a matcher).</summary>
    public static readonly IReadOnlyList<(string Event, bool Tools)> Claude =
    [
        (SessionStart, false), (UserPromptSubmit, false), (PreToolUse, true), (PostToolUse, true),
        (PermissionRequest, true), (PreCompact, false), (Stop, false), (StopFailure, false), (SessionEnd, false),
        (SubagentStart, false), (SubagentStop, false),
    ];
}

/// <summary>The words of the helper's command line that Claude Code's settings run: termilly-hook hook 1 PreToolUse.</summary>
internal static class HookCommands
{
    public const string Hook = "hook";
    public const string StatusLine = "statusline";
}
