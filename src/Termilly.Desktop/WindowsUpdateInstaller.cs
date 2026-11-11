using System.ComponentModel;
using System.Diagnostics;
using Microsoft.Win32;

namespace Termilly.Desktop;

/// <summary>
/// Installs an update on Windows: the downloaded setup runs quietly into the folder this copy was installed in (as
/// administrator for an install for all users), then starts Termilly again (SetupCommand). It closes Termilly's
/// processes itself, the background host's too, so kept shells end.
/// </summary>
internal sealed class WindowsUpdateInstaller : IUpdateInstaller
{
    /// <summary>Setup's entry in Apps &amp; features (installer/TermillySetup/Engine/Options.cs) and the folder it names.</summary>
    private const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Product.Name;
    private const string InstallLocation = "InstallLocation";
    /// <summary>The verb that starts a program as administrator.</summary>
    private const string RunAs = "runas";
    /// <summary>ERROR_CANCELLED: the administrator prompt was declined.</summary>
    private const int Cancelled = 1223;

    public bool EndsKeptShells => true;

    public async Task<UpdateInstallResult> InstallAsync(string file, CancellationToken cancel)
    {
        var scope = UpdateSignals.Scope(AppContext.BaseDirectory);
        using var shown = TryCreateSignal(scope, UpdateSignals.Shown);
        using var started = TryCreateSignal(scope, UpdateSignals.Started);
        shown?.Reset();
        started?.Reset();
        var command = SetupCommand.For(file, InstalledCopy.Match(AppContext.BaseDirectory, Location(RegistryHive.CurrentUser), Location(RegistryHive.LocalMachine)), scope);
#if DEBUG
        command = TestSetup(command);
#endif
        // Started in its own folder: Termilly's working folder is often its install folder (the shortcut's), and setup
        // can't swap that folder while a process sits in it.
        var start = new ProcessStartInfo(command.File, command.Arguments) { UseShellExecute = true, WorkingDirectory = System.IO.Path.GetDirectoryName(command.File)! };
        if (command.AsAdministrator)
        {
            start.Verb = RunAs;
        }
        try
        {
            Process.Start(start)?.Dispose();
            if (shown is not null)
            {
                var painted = await Task.Run(() => shown.WaitOne(TimeSpan.FromSeconds(2)), cancel).ConfigureAwait(false);
                StartupLog.Mark(painted ? "update window painted" : "update window paint wait timed out");
            }
            return UpdateInstallResult.Running;
        }
        catch (Win32Exception e) when (e.NativeErrorCode == Cancelled)
        {
            return UpdateInstallResult.Failed("Windows didn't get permission to install for all users, so nothing changed.");
        }
        catch (Win32Exception e)
        {
            return UpdateInstallResult.Failed($"Couldn't start setup: {e.Message}");
        }
    }

    private static System.Threading.EventWaitHandle? TryCreateSignal(string scope, string stage)
    {
        try { return UpdateSignals.Create(scope, stage); }
        catch (Exception e) when (e is Win32Exception or UnauthorizedAccessException or System.IO.IOException)
        {
            StartupLog.Mark($"update window paint signal unavailable: {e.Message}");
            return null;
        }
    }

    private static string? Location(RegistryHive hive)
    {
        using var root = RegistryKey.OpenBaseKey(hive, RegistryView.Registry64);
        using var key = root.OpenSubKey(UninstallKey);
        return key?.GetValue(InstallLocation) as string;
    }

#if DEBUG
    /// <summary>
    /// A Debug build can run a stand-in for setup (TERMILLY_UPDATE_SETUP: a program that gets setup's path and
    /// arguments), so the update can be tried without installing anything.
    /// </summary>
    private static SetupCommand TestSetup(SetupCommand command) =>
        Environment.GetEnvironmentVariable("TERMILLY_UPDATE_SETUP") is { Length: > 0 } stand
            ? command with { File = stand, Arguments = SetupCommand.Quote(command.File) + " " + command.Arguments }
            : command;
#endif
}
