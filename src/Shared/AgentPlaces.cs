using System.IO;
using System.Runtime.Versioning;
using Microsoft.Win32;

namespace Termilly.Shared;

/// <summary>
/// Where an agent may be installed besides the PATH a process has: folders to look in as PATH is (Windows' own PATH as
/// it is now, and the folders installers use), and package folders holding one folder per package (winget's). The
/// PATH a process has can be days old on Windows: Termilly passes on the one it started with, through updates and the
/// background host, so an agent installed since isn't on it.
/// </summary>
/// <param name="Folders">Looked in as PATH's folders are, in order.</param>
/// <param name="PackageRoots">Each holds a folder per package, looked in for the agent's program.</param>
internal sealed record AgentPlaces(IReadOnlyList<string> Folders, IReadOnlyList<string> PackageRoots)
{
    /// <summary>PATH alone.</summary>
    public static AgentPlaces None { get; } = new([], []);

    /// <summary>
    /// This user's places: on Windows, the machine's and the user's PATH as Windows has them now, then the folders
    /// installers put programs in (Claude Code's native installer, npm, Scoop, Bun, winget's links), and winget's
    /// package folders. Elsewhere none: the login shell's PATH and the installers' folders are already looked in there
    /// (LoginShellPath).
    /// </summary>
    public static AgentPlaces ForThisUser() => OperatingSystem.IsWindows() ? WindowsPlaces() : None;

    /// <summary>Windows' environment keys: the machine's (for every user) and this user's.</summary>
    private const string MachineEnvironmentKey = @"SYSTEM\CurrentControlSet\Control\Session Manager\Environment";
    private const string UserEnvironmentKey = "Environment";

    /// <summary>winget's folders: its links (the commands it adds) and its packages, per user and for the machine.</summary>
    private const string WingetUserFolder = @"Microsoft\WinGet";
    private const string WingetMachineFolder = "WinGet";
    private const string WingetLinks = "Links";
    private const string WingetPackages = "Packages";

    /// <summary>Where installers put a user's programs, under the profile and AppData.</summary>
    private const string NativeInstall = @".local\bin";
    private const string Npm = "npm";
    private const string ScoopShims = @"scoop\shims";
    private const string BunBin = @".bun\bin";

    [SupportedOSPlatform(OsPlatforms.Windows)]
    private static AgentPlaces WindowsPlaces()
    {
        var profile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var local = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        var roaming = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles);
        string[] installers =
        [
            Path.Combine(profile, NativeInstall), Path.Combine(roaming, Npm), Path.Combine(profile, ScoopShims),
            Path.Combine(profile, BunBin), Path.Combine(local, WingetUserFolder, WingetLinks), Path.Combine(programs, WingetMachineFolder, WingetLinks),
        ];
        var folders = PathFolders(SavedPath(Registry.LocalMachine, MachineEnvironmentKey))
            .Concat(PathFolders(SavedPath(Registry.CurrentUser, UserEnvironmentKey)))
            .Concat(installers);
        string[] packages = [Path.Combine(local, WingetUserFolder, WingetPackages), Path.Combine(programs, WingetMachineFolder, WingetPackages)];
        return new AgentPlaces([.. folders.Where(f => f.Length > 0).Distinct(StringComparer.OrdinalIgnoreCase)], packages);
    }

    /// <summary>A PATH's folders, %VARIABLES% expanded (Windows keeps them as written, as %USERPROFILE%\.local\bin).</summary>
    internal static IEnumerable<string> PathFolders(string? path) =>
        (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(folder => Environment.ExpandEnvironmentVariables(folder.Trim('"')));

    /// <summary>The PATH saved under an environment key, unexpanded; null when it can't be read.</summary>
    [SupportedOSPlatform(OsPlatforms.Windows)]
    private static string? SavedPath(RegistryKey root, string key)
    {
        try
        {
            using var environment = root.OpenSubKey(key);
            return environment?.GetValue(SystemVariables.Path, null, RegistryValueOptions.DoNotExpandEnvironmentNames) as string;
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            return null;
        }
    }
}
