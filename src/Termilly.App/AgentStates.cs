namespace Termilly.Desktop;

/// <summary>What a terminal's coding agent is doing, as the page shows it (its sidebar dot, header and inbox).</summary>
internal static class AgentStates
{
    /// <summary>An agent is there, waiting for a prompt.</summary>
    public const string Idle = "idle";
    public const string Working = "working";
    /// <summary>It asks the user something, or for permission.</summary>
    public const string NeedsInput = "needs-input";
    /// <summary>It finished its turn: idle, but with something new to look at.</summary>
    public const string Done = "done";
    public const string Error = "error";
    public const string Exited = "exited";
    /// <summary>Set by the page, not an agent: a program, a trigger or an alert wants the user (the amber dot).</summary>
    public const string Attention = "attention";
}
