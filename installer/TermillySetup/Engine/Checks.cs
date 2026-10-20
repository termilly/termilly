using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Termilly.Setup.Engine;

/// <summary>A line on the "Ready to install" page.</summary>
internal sealed record CheckItem(CheckState State, string Title, string Detail, string Tag, bool CanCloseTermilly = false);

internal enum CheckState
{
    Ok,
    WillInstall,
    Warning,
    Blocked,
}

/// <summary>What setup looks at before installing.</summary>
internal static class Checks
{
    /// <summary>Room to spare on the disk beyond Termilly's own size, in MB (runtimes, updates, logs).</summary>
    private const int SpareMb = 300;
    /// <summary>A check's tag when it's fine.</summary>
    private const string OkTag = "OK";

    private static double? _appMb;

    /// <summary>Termilly's size once unpacked, in MB.</summary>
    public static int AppMb(Payload payload)
    {
        if (_appMb is null)
        {
            using var zip = payload.OpenZip();
            _appMb = zip.Entries.Where(e => e.FullName.StartsWith(InstalledFiles.PayloadApp, StringComparison.Ordinal)).Sum(e => e.Length) / Bytes.PerMb;
        }
        return (int)Math.Ceiling(_appMb.Value);
    }

    public static double? FreeGb(string dir)
    {
        try
        {
            var root = Path.GetPathRoot(Path.GetFullPath(dir));
            return string.IsNullOrEmpty(root) ? null : new DriveInfo(root).AvailableFreeSpace / Bytes.PerGb;
        }
        catch (Exception e) when (e is ArgumentException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            return null;
        }
    }

    public static List<CheckItem> Run(SetupOptions options, Payload payload)
    {
        var items = new List<CheckItem>();
        var (windows, build) = Detect.Windows();
        items.Add(build >= Detect.MinimumBuild && Environment.Is64BitOperatingSystem
            ? new CheckItem(CheckState.Ok, windows, "", OkTag)
            : new CheckItem(CheckState.Blocked, windows, "Needs 64-bit Windows 10 1903 or later.", "Not supported"));

        foreach (var item in new[] { Prerequisite.DotNet, Prerequisite.WebView2 })
        {
            if (item.Installed() is not null)
            {
                items.Add(new CheckItem(CheckState.Ok, item.Name, "", OkTag));
                continue;
            }
            var how = options.PreferIncluded ? "From setup's own copy" : $"Downloaded from Microsoft, {item.ApproxMb} MB";
            if (item.NeedsAdmin && !Elevation.IsElevated)
            {
                how += " · asks for administrator permission";
            }
            items.Add(new CheckItem(CheckState.WillInstall, item.Name, how, "Will install"));
        }

        var needMb = AppMb(payload) + SpareMb;
        var free = FreeGb(options.InstallDir);
        items.Add(free is null || free.Value * Bytes.PerKb > needMb
            ? new CheckItem(CheckState.Ok, "Disk space", "", OkTag)
            : new CheckItem(CheckState.Blocked, "Disk space", $"{needMb} MB needed, {free.Value * Bytes.PerKb:0} MB free", "Not enough"));

        var running = Processes.InFolder(options.InstallDir);
        if (running.Count > 0)
        {
            items.Add(new CheckItem(CheckState.Warning, "Termilly is running",
                "It will be closed.", "", CanCloseTermilly: true));
        }
        foreach (var p in running)
        {
            p.Dispose();
        }
        return items;
    }
}
