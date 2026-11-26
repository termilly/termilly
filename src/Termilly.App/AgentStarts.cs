namespace Termilly.Desktop;

/// <summary>
/// How a terminal's agent session starts again at the next start, before the page is up (Features/EarlyAgents): the
/// page writes one into the session snapshot (js/snapshot.js) for each terminal whose Claude Code or Codex session
/// resumes by itself, and the host runs it as the page would have, a few seconds sooner.
/// </summary>
/// <param name="Profile">The terminal's shell profile.</param>
/// <param name="Folder">Where its shell starts: the folder the session belongs to.</param>
/// <param name="Env">The layout's own variables for the terminal, on top of the profile's.</param>
/// <param name="Command">What its shell runs at its first prompt: the agent's resume command.</param>
/// <param name="Cols">Its width when it was saved, so the agent draws at the size the page gives it.</param>
/// <param name="Rows">Its height when it was saved.</param>
internal sealed record AgentStart(
    string? Profile = null, string? Folder = null, Dictionary<string, string>? Env = null, string? Command = null, int Cols = 0, int Rows = 0);

/// <summary>A terminal's id and how its agent starts again.</summary>
internal sealed record PlannedStart(string Id, AgentStart Start);

/// <summary>A terminal's fields in the session snapshot that the host reads, besides its lines.</summary>
internal static class SnapshotFields
{
    /// <summary>How the terminal's agent session starts again (<see cref="AgentStart"/>).</summary>
    public const string AgentStart = "agentStart";
}

/// <summary>When a start command is typed into a new shell, after the prompt mark that says it's ready for it.</summary>
internal static class PromptTiming
{
    /// <summary>After the mark where input starts (OSC 133;B: PowerShell, zsh).</summary>
    public const int AtInputMs = 50;
    /// <summary>After the mark where the prompt starts (OSC 133;A: bash marks no input start).</summary>
    public const int AtPromptMs = 400;
    /// <summary>A shell that marks no prompt at all gets it after this long.</summary>
    public const int WithoutMarksMs = 5000;
}

/// <summary>What Termilly answers programs that ask the terminal about itself (as js/terminals.js does once it's up).</summary>
internal static class TerminalReplies
{
    /// <summary>The answer to XTVERSION (CSI &gt; 0 q): DCS &gt;| Termilly 1.10.0 ST.</summary>
    public static string Version(string version) => $"\u001bP>|{Product.Name} {version}\u001b\\";

    /// <summary>
    /// The answer to "where's the cursor" (CSI 6 n) from a terminal nobody has drawn in yet: its top left. PowerShell
    /// asks as it starts, and waits seconds for an answer.
    /// </summary>
    public const string CursorAtStart = "\u001b[1;1R";

    /// <summary>The answer to "what are you" (CSI c, primary device attributes), as the page's xterm.js gives it.</summary>
    public const string DeviceAttributes = "\u001b[?1;2c";
}
