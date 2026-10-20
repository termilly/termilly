namespace Termilly.Shared;

/// <summary>
/// The one-line JSON message the helper (Termilly.Agent) sends the app over its pipe for a hook, a status line or an
/// edit (Desktop's AgentHooks reads it), and the API requests that come the same way.
/// </summary>
internal static class HookMessage
{
    /// <summary>Version of the hook command line and message; bump when either changes.</summary>
    public const int Version = 1;

    /// <summary>The longest file path passed on: a cut path would name a different file, so a longer one is dropped.</summary>
    public const int MaxPath = 1000;

    /// <summary>The most folders passed for one shell command.</summary>
    public const int MaxFolders = 10;

    /// <summary>The message's fields.</summary>
    public static class Fields
    {
        public const string Version = "v";
        public const string Pane = "pane";
        public const string Event = "event";
        public const string Session = "session";
        public const string Tool = "tool";
        public const string Message = "message";
        public const string Reason = "reason";
        public const string Target = "target";
        public const string File = "file";
        public const string Cwd = "cwd";
        public const string Dirs = "dirs";

        // A subagent's events, and an Agent call.
        public const string AgentId = "agentId";
        public const string AgentType = "agentType";
        public const string Transcript = "transcript";
        public const string ToolUseId = "toolUseId";
        public const string Description = "description";
        public const string SubagentType = "subagentType";
        public const string Background = "background";
        public const string LaunchedId = "launchedId";

        // A status line's report.
        public const string Limits = "limits";
        public const string FiveHour = "fiveHour";
        public const string SevenDay = "sevenDay";
        public const string Used = "used";
        public const string ResetsAt = "resetsAt";
        public const string Context = "context";
        public const string Size = "size";
        public const string Tokens = "tokens";
        public const string Cost = "cost";
        public const string Usd = "usd";
        public const string DurationMs = "durationMs";

        // An edit.
        public const string Edit = "edit";
        public const string Edits = "edits";
        public const string Old = "old";
        public const string New = "new";
        public const string ReplaceAll = "replaceAll";
        public const string Content = "content";
        public const string CellId = "cellId";
        public const string NewSource = "newSource";
        public const string EditMode = "editMode";
        public const string Original = "original";
        public const string Truncated = "truncated";
    }
}

/// <summary>The app's one-line answers to a hook message, and what the hook looks for in them.</summary>
internal static class HookReplies
{
    /// <summary>The terminal is one of this window's.</summary>
    public const string Ok = "{\"ok\":true}";
    /// <summary>Not one of this window's terminals (or not a message at all).</summary>
    public const string Unknown = "{\"ok\":false}";
    /// <summary>Known, and please send the edit itself (the change preview's "full edit" mode).</summary>
    public const string SendEdit = "{\"ok\":true,\"send\":\"edit\"}";

    public const string OkMark = "\"ok\":true";
    public const string SendEditMark = "\"send\":\"edit\"";
}

/// <summary>How long each side of the pipe waits.</summary>
internal static class PipeTimeouts
{
    /// <summary>A hook gives up on the app after this: an agent must never wait on Termilly.</summary>
    public static readonly TimeSpan Hook = TimeSpan.FromSeconds(1);
    /// <summary>An edit carries whole files.</summary>
    public static readonly TimeSpan Edit = TimeSpan.FromSeconds(3);
    /// <summary>The app reads a message's line within this.</summary>
    public static readonly TimeSpan Read = TimeSpan.FromSeconds(2);
    /// <summary>An API call; the page may need a moment.</summary>
    public static readonly TimeSpan Api = TimeSpan.FromSeconds(10);
    /// <summary>An API call that may wait on the user (typing into a terminal on production asks first) or on output.</summary>
    public static readonly TimeSpan ApiWaiting = TimeSpan.FromMinutes(2);

    /// <summary>How long a call to <paramref name="method"/> may take.</summary>
    public static TimeSpan ForApi(string? method) => method is ApiMethods.Send or ApiMethods.Snippet or ApiMethods.Wait ? ApiWaiting : Api;
}

/// <summary>What Termilly puts in each terminal's environment for the helper and the claude shim to find it.</summary>
internal static class TerminalEnvironment
{
    /// <summary>The terminal's id in Termilly: which pane an event belongs to.</summary>
    public const string PaneId = "TERMILLY_PANE_ID";
    /// <summary>The named pipe of the Termilly window that owns the terminal.</summary>
    public const string Pipe = "TERMILLY_PIPE";
    /// <summary>Claude Code settings file holding Termilly's hooks; the shim passes it with --settings.</summary>
    public const string AgentSettings = "TERMILLY_AGENT_SETTINGS";
    /// <summary>Set by the shim for the Claude Code it starts, so a claude started from inside it isn't hooked twice.</summary>
    public const string AgentShim = "TERMILLY_AGENT_SHIM";
    /// <summary>The credential ssh's askpass helper reads (SshConnections sets it, Termilly.Agent/Askpass.cs reads it).</summary>
    public const string Credential = "TERMILLY_CREDENTIAL";
}

/// <summary>
/// The names the agent helper (termilly-hook) is copied under next to the app: it does a different job under each
/// (Termilly.Agent/Program.cs).
/// </summary>
internal static class AgentExecutables
{
    /// <summary>What Claude Code's hooks and status line run.</summary>
    public const string Hook = "termilly-hook";
    /// <summary>The shim terminals find first on PATH: it starts the real Claude Code with Termilly's hooks.</summary>
    public const string Claude = "claude";
    /// <summary>The termilly command (the API and MCP server) for scripts and agents.</summary>
    public const string Cli = "termilly";
    /// <summary>ssh's askpass helper: answers a password prompt from the saved credential.</summary>
    public const string Askpass = "termilly-askpass";
}

/// <summary>The names of a Termilly window's pipe (for hooks and the API): its own, or the fixed one.</summary>
internal static class PipeNames
{
    /// <summary>A window's pipe is this followed by its process id.</summary>
    public const string Prefix = "termilly-";
    /// <summary>
    /// The pipe a window uses while the background host keeps its shells (Features/BackgroundHost.cs), so their hooks
    /// still find the next window.
    /// </summary>
    public const string Main = "termilly-main";

    public static string ForProcess(int processId) => Prefix + processId;
}
