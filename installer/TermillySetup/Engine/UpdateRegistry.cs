using System.Diagnostics;
using System.IO;
using Microsoft.Win32;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>
/// The two registry values an update at start touches, both this user's: the sign-in entry that settles an update cut
/// off by a restart or power loss, and the version Apps &amp; features shows.
/// </summary>
internal static class UpdateRegistry
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RecoverValue = Product.Name + "UpdateRecover";

    /// <summary>Runs <paramref name="setup"/> with --update-recover at the next sign-in, until it's removed.</summary>
    public static void AddRecovery(string setup, string dir)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKey);
        key.SetValue(RecoverValue, $"\"{setup}\" {SetupFlags.UpdateRecover} {SetupFlags.Dir} \"{dir.TrimEnd('\\')}\"");
        Log.Write("added the sign-in recovery entry");
    }

    public static void RemoveRecovery()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
        if (key?.GetValue(RecoverValue) is not null)
        {
            key.DeleteValue(RecoverValue, throwOnMissingValue: false);
            Log.Write("removed the sign-in recovery entry");
        }
    }

    /// <summary>Apps &amp; features shows the version of the Termilly.exe now in <paramref name="dir"/>.</summary>
    public static void ShowVersionOf(string dir)
    {
        if (VersionOf(dir) is not { } version)
        {
            return;
        }
        using var root = RegistryKey.OpenBaseKey(RegistryHive.CurrentUser, RegistryView.Registry64);
        using var key = root.OpenSubKey(InstalledTermilly.UninstallKey, writable: true);
        key?.SetValue(WindowsNames.DisplayVersion, version);
    }

    /// <summary>The version of the Termilly.exe in <paramref name="dir"/> ("1.9.2", without a build suffix), or null.</summary>
    public static string? VersionOf(string dir)
    {
        var exe = Path.Combine(dir, InstalledFiles.App);
        if (!File.Exists(exe))
        {
            return null;
        }
        var version = FileVersionInfo.GetVersionInfo(exe).ProductVersion;
        return string.IsNullOrEmpty(version) ? null : version!.Split('+')[0];
    }
}
