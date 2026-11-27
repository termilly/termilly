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

    /// <summary>
    /// <see cref="FindReal(string, string?, string?, string?)"/>, then the same in <paramref name="places"/>' folders,
    /// then in its package folders (<see cref="FindPackaged"/>): one way of finding any agent, whatever its name.
    /// </summary>
    public static string? FindInstalled(string name, string? path, string? pathExt, string? skipDirectory, AgentPlaces places) =>
        FindReal(name, path, pathExt, skipDirectory)
        ?? FindReal(name, string.Join(Path.PathSeparator, places.Folders), pathExt, skipDirectory)
        ?? FindPackaged(name, places.PackageRoots, skipDirectory);

    /// <summary>
    /// How a program is named when its release keeps its platform in the name (Rust's target, as
    /// codex-x86_64-pc-windows-msvc.exe): winget unpacks such a release as it is and its alias may never be made.
    /// The agent's name comes first, so a helper beside it (codex-command-runner.exe) doesn't match.
    /// </summary>
    private const string PlatformNamed = "-*-pc-windows-*";

    /// <summary>
    /// The agent in one of the package folders under <paramref name="roots"/> (winget's): <paramref name="name"/>.exe,
    /// or its platform-named program (<see cref="PlatformNamed"/>). Only packages named after the agent are looked in
    /// (OpenAI.Codex_… for codex), so another package's program of the same name isn't taken; in name order, so the
    /// same one is found each time.
    /// </summary>
    /// <param name="skipDirectory">A folder never looked in: the shim's own.</param>
    public static string? FindPackaged(string name, IReadOnlyList<string> roots, string? skipDirectory = null)
    {
        var skip = skipDirectory is null ? null : Normalize(skipDirectory);
        foreach (var root in roots)
        {
            foreach (var package in PackagesNamed(root, name))
            {
                if (string.Equals(Normalize(package), skip, StringComparison.OrdinalIgnoreCase) || ProgramIn(package, name) is not { } found)
                {
                    continue;
                }
                return found;
            }
        }
        return null;
    }

    /// <summary>The package folders under <paramref name="root"/> with <paramref name="name"/> in their name, in name order.</summary>
    private static IEnumerable<string> PackagesNamed(string root, string name)
    {
        try
        {
            return Directory.Exists(root)
                ? [.. Directory.EnumerateDirectories(root).Where(p => Path.GetFileName(p).Contains(name, StringComparison.OrdinalIgnoreCase)).Order(StringComparer.OrdinalIgnoreCase)]
                : [];
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return [];
        }
    }

    /// <summary>The agent's program in one package folder: <paramref name="name"/>.exe first, else its platform-named one.</summary>
    private static string? ProgramIn(string package, string name)
    {
        try
        {
            if (IsAgentFolder(package))
            {
                return null;
            }
            var exact = Path.Combine(package, name + WindowsExe);
            return File.Exists(exact)
                ? exact
                : Directory.EnumerateFiles(package, name + PlatformNamed + WindowsExe).Order(StringComparer.OrdinalIgnoreCase).FirstOrDefault();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null; // being replaced (an upgrade) or locked: the next package
        }
    }

    /// <summary><see cref="FindReal(string, string?, string?, string?)"/> on this process's PATH.</summary>
    public static string? FindReal(string name) =>
        FindReal(name, Environment.GetEnvironmentVariable(SystemVariables.Path), Environment.GetEnvironmentVariable(SystemVariables.PathExt));

    private static string Normalize(string directory) =>
        Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);

    private static bool IsAgentFolder(string directory) =>
        Directory.EnumerateFiles(directory, AgentExecutables.Hook + "*").Any();
}
