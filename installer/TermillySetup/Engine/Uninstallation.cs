using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>Uninstalls Termilly: what it added to Windows, its files and, when asked, the user's settings and history.</summary>
internal static class Uninstallation
{
    private const string RunValue = "Termilly background shells";
    private const string AppUserModelId = "Termilly.Termilly";
    /// <summary>Windows' Run key (programs started at sign-in) and its AppUserModelId registrations, under this user.</summary>
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string AppUserModelIds = @"Software\Classes\AppUserModelId\";

    /// <summary>Where the Uninstalling page's bar is at each step.</summary>
    private static class UninstallAt
    {
        public const double Closing = 0.1;
        public const double Shortcuts = 0.3;
        public const double Files = 0.5;
        public const double Data = 0.8;
        public const double Done = 1;
    }

    public static async Task UninstallAsync(InstalledTermilly installed, bool keepData, Action<string, double> report, CancellationToken cancel)
    {
        var dir = installed.Dir;
        Log.Write($"uninstalling Termilly {installed.Version} from {dir}, keep data: {keepData}");
        report("Closing Termilly…", UninstallAt.Closing);
        await Task.Run(() => Processes.CloseAll(dir), cancel).ConfigureAwait(false);

        report("Removing shortcuts and the Explorer menu…", UninstallAt.Shortcuts);
        Unregister(dir, installed.AllUsers);

        report("Removing Termilly's files…", UninstallAt.Files);
        await Task.Run(() => RemoveFiles(dir), cancel).ConfigureAwait(false);
        if (!keepData)
        {
            report("Removing your settings and history…", UninstallAt.Data);
            await Task.Run(() => Folders.Delete(Folders.Data, Folders.UninstallRetries), cancel).ConfigureAwait(false);
        }
        report(UiText.Done, UninstallAt.Done);
    }

    /// <summary>Takes Termilly out of Windows: shortcuts, the Explorer menu, PATH, its entries, and what it registered itself.</summary>
    private static void Unregister(string dir, bool all)
    {
        Shell.Delete(Shell.StartMenuShortcut(all));
        Shell.Delete(Shell.DesktopShortcut(all));
        Shell.RemoveExplorerMenu(all);
        Shell.RemoveFromPath(all, Path.Combine(dir, InstalledFiles.Bin));
        using (var root = RegistryKey.OpenBaseKey(all ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64))
        {
            root.DeleteSubKeyTree(InstalledTermilly.UninstallKey, throwOnMissingSubKey: false);
            root.DeleteSubKeyTree(InstalledTermilly.SetupKey, throwOnMissingSubKey: false);
        }
        // What Termilly itself registered, for this user.
        using (var run = Registry.CurrentUser.OpenSubKey(RunKey, writable: true))
        {
            run?.DeleteValue(RunValue, throwOnMissingValue: false);
        }
        Registry.CurrentUser.DeleteSubKeyTree(AppUserModelIds + AppUserModelId, throwOnMissingSubKey: false);
    }

    /// <summary>Removes the install folder, the setup copy in it moved out of the way first.</summary>
    private static void RemoveFiles(string dir)
    {
        // The setup copy that started this one may still be running from the folder (Apps & features runs it):
        // a running exe can't be deleted, but it can be moved out of the way.
        var setup = Path.Combine(dir, InstalledFiles.Setup);
        if (File.Exists(setup) && Path.GetPathRoot(setup) == Path.GetPathRoot(Log.Folder))
        {
            try
            {
                Directory.CreateDirectory(Log.Folder);
                File.Move(setup, Path.Combine(Log.Folder, $"old-{Guid.NewGuid():N}.exe"));
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Log.Write($"couldn't move the old setup copy: {e.Message}");
            }
        }
        Folders.Delete(dir, Folders.UninstallRetries);
    }
}
