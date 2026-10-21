using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>
/// Setup's command line: Quiet.cs documents the ones for scripts; the others are setup's own restarts. The ones
/// Termilly's update runs setup with are shared with it (src/Shared/SetupFlags.cs).
/// </summary>
internal static class Flags
{
    public const string Quiet = SetupFlags.Quiet;
    public const string Start = SetupFlags.Start;
    public const string Uninstall = "--uninstall";
    public const string RemoveData = "--remove-data";
    public const string AllUsers = SetupFlags.AllUsers;
    public const string Dir = SetupFlags.Dir;
    public const string Desktop = "--desktop";
    public const string Path = "--path";
    public const string NoPath = "--no-path";
    public const string SignIn = "--sign-in";
    public const string Offline = "--offline";
    public const string NoStartMenu = "--no-start-menu";
    public const string NoExplorer = "--no-explorer";
    public const string NoAgent = "--no-agent";
    /// <summary>Setup restarted as administrator to install, with the options as their argument.</summary>
    public const string ElevatedInstall = "--elevated-install";
    /// <summary>Setup running from a temporary copy, so it can remove the folder it was installed in.</summary>
    public const string TempCopy = "--temp-copy";
}

/// <summary>What a quiet run exits with.</summary>
internal static class ExitCodes
{
    public const int Done = 0;
    /// <summary>It failed; the log in %TEMP% says why.</summary>
    public const int Failed = 1;
}

/// <summary>Codes Windows and installers report that setup acts on.</summary>
internal static class WindowsCodes
{
    /// <summary>ERROR_ELEVATION_REQUIRED: run it as administrator.</summary>
    public const int ElevationRequired = 740;
    /// <summary>ERROR_CANCELLED: the permission prompt was declined.</summary>
    public const int Cancelled = 1223;
    /// <summary>ERROR_PRODUCT_VERSION: a newer version is already installed.</summary>
    public const int NewerInstalled = 1638;
    /// <summary>ERROR_SUCCESS_REBOOT_REQUIRED: installed, and Windows wants a restart later.</summary>
    public const int RestartRequired = 3010;
}

/// <summary>Termilly's installed files and shortcuts, and where setup keeps them in its payload.</summary>
internal static class InstalledFiles
{
    public const string App = "Termilly.exe";
    /// <summary>Its process name, which the background host and the agent helpers don't share.</summary>
    public const string AppProcess = "Termilly";
    public const string Setup = "TermillySetup.exe";
    /// <summary>The folder put on PATH, with termilly.cmd in it.</summary>
    public const string Bin = "bin";
    public const string CommandShim = "termilly.cmd";
    public const string Shortcut = "Termilly.lnk";
    /// <summary>The folder Termilly's files are in, in setup's zip.</summary>
    public const string PayloadApp = "app/";
}

/// <summary>Names Windows defines: registry values and variables.</summary>
internal static class WindowsNames
{
    /// <summary>An uninstall entry's version and folder (Apps &amp; features).</summary>
    public const string DisplayVersion = "DisplayVersion";
    public const string InstallLocation = "InstallLocation";
    /// <summary>The 64-bit Program Files, also from a 32-bit process.</summary>
    public const string ProgramFiles64 = "ProgramW6432";
    /// <summary>The verb that starts a program as administrator.</summary>
    public const string RunAs = "runas";
    /// <summary>The PATH variable in the registry, and the setting change that tells programs it changed.</summary>
    public const string Path = "Path";
    public const string Environment = "Environment";
}

/// <summary>Sizes in bytes.</summary>
internal static class Bytes
{
    public const int PerKb = 1024;
    public const double PerMb = PerKb * 1024.0;
    public const double PerGb = PerMb * 1024;
    /// <summary>The buffer files and downloads are copied through.</summary>
    public const int CopyBuffer = 81920;
}

/// <summary>Words the pages show for more than one step.</summary>
internal static class UiText
{
    /// <summary>The last progress line, of an install and of an uninstall.</summary>
    public const string Done = "Done";
}
