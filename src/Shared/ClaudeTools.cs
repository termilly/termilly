namespace Termilly.Shared;

/// <summary>The Claude Code tools Termilly knows by name.</summary>
internal static class ClaudeTools
{
    public const string Edit = "Edit";
    public const string Write = "Write";
    public const string MultiEdit = "MultiEdit";
    public const string NotebookEdit = "NotebookEdit";
    public const string NotebookRead = "NotebookRead";
    public const string Read = "Read";
    public const string Bash = "Bash";
    public const string PowerShell = "PowerShell";
    public const string Grep = "Grep";
    public const string Glob = "Glob";
    /// <summary>Starts a subagent; older Claude Code calls it Task.</summary>
    public const string Agent = "Agent";
    public const string Task = "Task";
    /// <summary>Claude asking the user a question: it needs them, though no permission is involved.</summary>
    public const string AskUserQuestion = "AskUserQuestion";

    /// <summary>The tools that change a file; Termilly's change preview follows these.</summary>
    public static readonly IReadOnlyList<string> EditTools = [Edit, Write, MultiEdit, NotebookEdit];

    /// <summary>Claude's shell tools: a command can create or change files too.</summary>
    public static readonly IReadOnlyList<string> ShellTools = [Bash, PowerShell];
}
