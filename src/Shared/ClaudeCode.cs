namespace Termilly.Shared;

/// <summary>Where Claude Code keeps its settings and transcripts, as Termilly reads them.</summary>
internal static class ClaudeCodeFiles
{
    /// <summary>Moves Claude Code's folder away from ~/.claude.</summary>
    public const string ConfigVariable = "CLAUDE_CONFIG_DIR";
    /// <summary>The Git Bash Claude Code runs hooks and status lines with on Windows, when set.</summary>
    public const string GitBashVariable = "CLAUDE_CODE_GIT_BASH_PATH";
    /// <summary>Claude Code's folder in the profile, and in a project.</summary>
    public const string Folder = ".claude";
    public const string Settings = "settings.json";
    /// <summary>A project's settings that aren't committed.</summary>
    public const string LocalSettings = "settings.local.json";
    /// <summary>The transcripts, a folder per project.</summary>
    public const string Projects = "projects";

    /// <summary>Claude Code's folder: CLAUDE_CONFIG_DIR, else ~/.claude.</summary>
    public static string ConfigDirectory() =>
        Environment.GetEnvironmentVariable(ConfigVariable) is { } set && !string.IsNullOrWhiteSpace(set)
            ? set
            : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Folder);
}

/// <summary>The system's own environment variables Termilly reads.</summary>
internal static class SystemVariables
{
    public const string Path = "PATH";
    /// <summary>The extensions Windows runs a command name with (.COM;.EXE;...).</summary>
    public const string PathExt = "PATHEXT";
}
