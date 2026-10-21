namespace Termilly.Desktop;

/// <summary>Where an update the user asked for is (the page's UPDATE_STATE).</summary>
internal static class UpdateStates
{
    public const string Downloading = "downloading";
    /// <summary>Downloaded and checked: "Restart to update" installs it.</summary>
    public const string Ready = "ready";
    public const string Installing = "installing";
    public const string Failed = "failed";
    /// <summary>It can't be installed from Termilly here: the user runs the command it gives.</summary>
    public const string ByHand = "byHand";
}

/// <summary>
/// Installs a downloaded update when the user says "Restart to update": Windows runs setup quietly, Linux installs
/// the package with the system's password prompt. Each system's app registers its own.
/// </summary>
internal interface IUpdateInstaller
{
    /// <summary>
    /// Whether installing ends the shells even when the background host keeps them: Windows' setup replaces the
    /// host's files, so it has to end the host first.
    /// </summary>
    bool EndsKeptShells { get; }

    /// <summary>Starts installing <paramref name="file"/>. When it answers Started, Termilly closes and the installer opens it again.</summary>
    Task<UpdateInstallResult> InstallAsync(string file, CancellationToken cancel);
}

/// <summary>How starting an install went: started (Termilly should close now), failed, or left for the user to run.</summary>
/// <param name="Error">Why it didn't start, for the user.</param>
/// <param name="Command">A command the user can run themselves instead (Linux without a password prompt).</param>
internal sealed record UpdateInstallResult(bool Started, string? Error = null, string? Command = null)
{
    public static readonly UpdateInstallResult Running = new(true);

    public static UpdateInstallResult Failed(string error) => new(false, error);

    public static UpdateInstallResult ByHand(string command) => new(false, Command: command);
}

/// <summary>
/// The setup command an update runs on Windows: the downloaded setup, quiet, into the folder Termilly is installed in
/// (for all users too, then as administrator), starting Termilly again once it's done.
/// </summary>
internal sealed record SetupCommand(string File, string Arguments, bool AsAdministrator)
{
    /// <param name="setup">The downloaded setup.</param>
    /// <param name="installed">The install this copy runs from, or null for a copy setup didn't install (a build).</param>
    public static SetupCommand For(string setup, InstalledCopy? installed)
    {
        var arguments = $"{SetupFlags.Quiet} {SetupFlags.Start}";
        if (installed is not null)
        {
            arguments += (installed.AllUsers ? $" {SetupFlags.AllUsers}" : "") + $" {SetupFlags.Dir} {Quote(installed.Dir)}";
        }
        return new SetupCommand(setup, arguments, installed?.AllUsers == true);
    }

    /// <summary>Quotes one argument for a Windows command line (setup reads it back with CommandLineToArgvW's rules).</summary>
    public static string Quote(string value) => "\"" + value.TrimEnd('\\').Replace("\"", "\\\"") + "\"";
}

/// <summary>Where setup installed this copy of Termilly, and whether for all users.</summary>
internal sealed record InstalledCopy(string Dir, bool AllUsers)
{
    /// <summary>
    /// The install, out of setup's per-user and all-users entries (either may be missing), that is the folder this
    /// copy runs from; null when neither is (a build, or a copy moved by hand).
    /// </summary>
    public static InstalledCopy? Match(string runningFrom, string? perUser, string? allUsers)
    {
        if (Same(perUser, runningFrom))
        {
            return new InstalledCopy(perUser!, false);
        }
        return Same(allUsers, runningFrom) ? new InstalledCopy(allUsers!, true) : null;
    }

    private static bool Same(string? dir, string runningFrom) =>
        !string.IsNullOrWhiteSpace(dir) && Normal(dir).Equals(Normal(runningFrom), StringComparison.OrdinalIgnoreCase);

    private static string Normal(string dir) => System.IO.Path.GetFullPath(dir).TrimEnd('\\', '/');
}

/// <summary>The commands an update runs on Linux: the package through the password prompt, and Termilly again after.</summary>
internal static class PackageCommands
{
    public const string Elevate = "pkexec";
    public const string Apt = "apt-get";
    /// <summary>The command the deb puts on PATH (installer/linux/termilly-launcher.sh).</summary>
    public const string Termilly = "/usr/bin/termilly";
    /// <summary>pkexec's exit codes: the password prompt was closed; no permission could be had (no prompt to ask with).</summary>
    public const int Dismissed = 126;
    public const int NotAuthorized = 127;

    /// <summary>pkexec's arguments: apt installs the package file (a path, so apt doesn't look it up by name) and what it needs.</summary>
    public static IReadOnlyList<string> Install(string package) => [Apt, "install", "-y", System.IO.Path.GetFullPath(package)];

    /// <summary>The command to type instead, when there's no password prompt to ask with.</summary>
    public static string ByHand(string package) => $"sudo apt install '{System.IO.Path.GetFullPath(package).Replace("'", "'\\''")}'";

    /// <summary>
    /// A shell script that waits for this Termilly (<paramref name="pid"/>) to end, then starts the new one: started
    /// before closing, as nothing is left to start it after.
    /// </summary>
    public static string RestartScript(int pid) => $"while kill -0 {pid} 2>/dev/null; do sleep 0.2; done; exec {Termilly}";
}
