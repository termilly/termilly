using System.IO;

namespace Termilly.Shared;

/// <summary>The coding agents Termilly knows by their hooks, as hook messages and the page name them.</summary>
internal static class AgentKinds
{
    public const string Claude = "claude";
    public const string Codex = "codex";

    /// <summary>Their names in what Termilly says.</summary>
    public const string ClaudeName = "Claude Code";
    public const string CodexName = "Codex";
}

/// <summary>
/// Finds an agent's real program on PATH (claude, codex), skipping Termilly's own shims: the shim itself starts it, and
/// the new-terminal list shows an agent only when it's installed.
/// </summary>
internal static class AgentLookup
{
    /// <summary>A program's extension on Windows.</summary>
    public const string WindowsExe = ".exe";

    /// <summary>What Windows runs when PATHEXT isn't set.</summary>
    private const string DefaultPathExt = ".COM;.EXE;.BAT;.CMD";

    private const UnixFileMode Executable = UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    /// <summary>
    /// The first <paramref name="name"/> on <paramref name="path"/> that isn't a Termilly's shim: each folder in PATH
    /// order, and on Windows each extension in PATHEXT order (claude.exe from the native installer, claude.cmd and
    /// codex.cmd from npm, codex.exe on its own). Elsewhere, the first executable file named <paramref name="name"/>.
    /// A folder holding Termilly's hook helper is a Termilly's agent folder (this one's, or another Termilly's that
    /// started this one), whose shim would start the other and loop without end.
    /// </summary>
    /// <param name="skipDirectory">A folder never looked in: the shim's own.</param>
    public static string? FindReal(string name, string? path, string? pathExt, string? skipDirectory = null)
    {
        var skip = skipDirectory is null ? null : Normalize(skipDirectory);
        var extensions = !OperatingSystem.IsWindows() ? [""] : (string.IsNullOrWhiteSpace(pathExt) ? DefaultPathExt : pathExt)
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(ext => !ext.Equals(".ps1", StringComparison.OrdinalIgnoreCase)); // a script needs PowerShell to start it
        foreach (var directory in (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string full;
            try
            {
                full = Normalize(Environment.ExpandEnvironmentVariables(directory.Trim('"')));
                if (string.Equals(full, skip, StringComparison.OrdinalIgnoreCase) || !Directory.Exists(full) || IsAgentFolder(full))
                {
                    continue;
                }
            }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (var ext in extensions)
            {
                var candidate = Path.Combine(full, name + ext.ToLowerInvariant());
                if (File.Exists(candidate) && (OperatingSystem.IsWindows() || (File.GetUnixFileMode(candidate) & Executable) != 0))
                {
                    return candidate;
                }
            }
        }
        return null;
    }

    /// <summary><see cref="FindReal(string, string?, string?, string?)"/> on this process's PATH.</summary>
    public static string? FindReal(string name) =>
        FindReal(name, Environment.GetEnvironmentVariable(SystemVariables.Path), Environment.GetEnvironmentVariable(SystemVariables.PathExt));

    private static string Normalize(string directory) =>
        Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool IsAgentFolder(string directory) =>
        Directory.EnumerateFiles(directory, AgentExecutables.Hook + "*").Any();
}
