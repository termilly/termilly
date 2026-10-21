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

    public Task<UpdateInstallResult> InstallAsync(string file, CancellationToken cancel)
    {
        var command = SetupCommand.For(file, InstalledCopy.Match(AppContext.BaseDirectory, Location(RegistryHive.CurrentUser), Location(RegistryHive.LocalMachine)));
#if DEBUG
        command = TestSetup(command);
#endif
        var start = new ProcessStartInfo(command.File, command.Arguments) { UseShellExecute = true };
        if (command.AsAdministrator)
        {
            start.Verb = RunAs;
        }
        try
        {
            Process.Start(start)?.Dispose();
            return Task.FromResult(UpdateInstallResult.Running);
        }
        catch (Win32Exception e) when (e.NativeErrorCode == Cancelled)
        {
            return Task.FromResult(UpdateInstallResult.Failed("Windows didn't get permission to install for all users, so nothing changed."));
        }
        catch (Win32Exception e)
        {
            return Task.FromResult(UpdateInstallResult.Failed($"Couldn't start setup: {e.Message}"));
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
