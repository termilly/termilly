using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>One line of the Installing page's task list.</summary>
internal enum Step
{
    Runtime,
    WebView2,
    Files,
    Windows,
    Check,
}

/// <summary>Progress for the Installing page: which step, its text, and 0..1 overall (or -1 while unknown).</summary>
internal sealed record Progress(Step Step, string Text, double Fraction, bool Done = false, string? Note = null);

/// <summary>Installs, updates and uninstalls Termilly. Every step logs; a failed install puts the old files back.</summary>
internal sealed class Installation
{
    /// <summary>Next to the install folder: the new files while they're copied, the old ones until the new are in.</summary>
    private const string StagingSuffix = ".new";
    private const string BackupSuffix = ".old";
    /// <summary>How often extraction reports progress, in files.</summary>
    private const int ProgressEvery = 20;

    /// <summary>Where the Installing page's bar is at each step (0 to 1).</summary>
    private static class At
    {
        public const double Verify = 0.02;
        public const double RuntimeFrom = 0.04;
        public const double RuntimeTo = 0.35;
        public const double WebView2To = 0.55;
        public const double Closing = 0.56;
        public const double Copying = 0.6;
        /// <summary>The share of the bar copying the files takes.</summary>
        public const double CopyingShare = 0.25;
        public const double Copied = 0.86;
        public const double Shortcuts = 0.88;
        public const double Registered = 0.94;
        public const double Checking = 0.96;
        public const double Done = 1;
    }

    private readonly Payload _payload;
    private readonly SetupOptions _options;

    public Installation(Payload payload, SetupOptions options)
    {
        _payload = payload;
        _options = options;
    }

    /// <summary>Whether the .NET runtime came from setup's own copy (the Done page says so).</summary>
    public bool UsedIncludedRuntime { get; private set; }

    public async Task InstallAsync(Action<Progress> report, CancellationToken cancel)
    {
        var dir = _options.InstallDir;
        Log.Write($"installing Termilly {_payload.Version} to {dir} ({(_options.AllUsers ? "all users" : "this user")})");

        report(new Progress(Step.Runtime, "Checking setup's files…", At.Verify));
        if (!await Task.Run(_payload.Verify, cancel).ConfigureAwait(false))
        {
            throw new SetupException("Setup is damaged: its files don't match what was built.", "Download setup again from termilly.com.");
        }
        await InstallRuntimesAsync(report, cancel).ConfigureAwait(false);
        await CopyFilesAsync(dir, report, cancel).ConfigureAwait(false);

        report(new Progress(Step.Windows, "Adding shortcuts…", At.Shortcuts));
        var exe = Path.Combine(dir, InstalledFiles.App);
        try
        {
            RegisterWindows(dir, exe);
            TermillySettings.Write(_options);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or System.Security.SecurityException or COMException)
        {
            throw new SetupException("Termilly's files are installed, but Windows integration failed: " + e.Message, "Retry, or run setup as administrator.");
        }
        report(new Progress(Step.Windows, "Shortcuts and uninstall entry added", At.Registered, Done: true));

        report(new Progress(Step.Check, "Checking the installation…", At.Checking));
        if (!File.Exists(exe))
        {
            throw new SetupException("Termilly.exe is missing after copying.", "Retry; if it happens again, an antivirus may be removing it.");
        }
        var installed = FileVersionInfo.GetVersionInfo(exe).ProductVersion ?? "?";
        Log.Write($"Termilly.exe {installed} is in place");
        Folders.Delete(dir + BackupSuffix);
        report(new Progress(Step.Check, UiText.Done, At.Done, Done: true));
    }

    /// <summary>.NET and WebView2, each only when it's missing.</summary>
    private async Task InstallRuntimesAsync(Action<Progress> report, CancellationToken cancel)
    {
        foreach (var (item, step, from, to) in new[]
        {
            (Prerequisite.DotNet, Step.Runtime, At.RuntimeFrom, At.RuntimeTo), (Prerequisite.WebView2, Step.WebView2, At.RuntimeTo, At.WebView2To),
        })
        {
            if (item.Installed() is { } version)
            {
                Log.Write($"{item.Name}: {version} is installed");
                report(new Progress(step, $"{item.Name} {version} is already installed", to, Done: true, Note: "already installed"));
                continue;
            }
            var included = await PrerequisiteInstaller.InstallAsync(item, _payload, _options.PreferIncluded,
                (text, fraction) => report(new Progress(step, text, fraction < 0 ? -1 : from + (to - from) * fraction)), cancel).ConfigureAwait(false);
            if (step == Step.Runtime)
            {
                UsedIncludedRuntime = included;
            }
            report(new Progress(step, $"{item.Name} installed", to, Done: true, Note: included ? "included copy" : "downloaded"));
        }
    }

    /// <summary>Termilly's files, copied next to the folder first; the old ones stay until the new ones are in place.</summary>
    private async Task CopyFilesAsync(string dir, Action<Progress> report, CancellationToken cancel)
    {
        report(new Progress(Step.Files, "Closing Termilly…", At.Closing));
        await Task.Run(() => Processes.CloseAll(dir), cancel).ConfigureAwait(false);
        report(new Progress(Step.Files, "Copying Termilly…", At.Copying));
        var staging = dir + StagingSuffix;
        var backup = dir + BackupSuffix;
        await Task.Run(() =>
        {
            Folders.Delete(staging);
            Folders.Delete(backup);
            Directory.CreateDirectory(staging);
            ExtractApp(staging, fraction => report(new Progress(Step.Files, "Copying Termilly…", At.Copying + At.CopyingShare * fraction)));
            _payload.WriteProgram(Path.Combine(staging, InstalledFiles.Setup));
            if (_options.PathCommand)
            {
                WriteCommandShim(staging);
            }
        }, cancel).ConfigureAwait(false);
        try
        {
            if (Directory.Exists(dir))
            {
                Directory.Move(dir, backup);
            }
            Directory.Move(staging, dir);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Put things back the way they were: the old install, untouched.
            if (!Directory.Exists(dir) && Directory.Exists(backup))
            {
                Directory.Move(backup, dir);
                Log.Write("rolled back: the previous installation is back in place");
            }
            Folders.Delete(staging);
            throw new SetupException($"Termilly's folder is in use: {dir}",
                "Close Termilly and any terminal or Explorer window open in that folder, then retry.");
        }
        report(new Progress(Step.Files, "Termilly copied", At.Copied, Done: true, Note: $"{Folders.SizeMb(dir):0} MB"));
    }

    private void ExtractApp(string target, Action<double> progress)
    {
        using var zip = _payload.OpenZip();
        var files = zip.Entries.Where(e => Name(e).StartsWith(InstalledFiles.PayloadApp, StringComparison.Ordinal) && e.Name.Length > 0).ToList();
        var root = Path.GetFullPath(target) + Path.DirectorySeparatorChar;
        for (var i = 0; i < files.Count; i++)
        {
            var path = Path.GetFullPath(Path.Combine(target, Name(files[i]).Substring(InstalledFiles.PayloadApp.Length).Replace('/', Path.DirectorySeparatorChar)));
            if (!path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
            {
                throw new SetupException("Setup's files are malformed.", "Download setup again from termilly.com.");
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            files[i].ExtractToFile(path, overwrite: true);
            if (i % ProgressEvery == 0)
            {
                progress((double)i / files.Count);
            }
        }
        Log.Write($"extracted {files.Count} files");
        if (files.Count == 0)
        {
            throw new SetupException("Setup has no Termilly files in it.", "Download setup again from termilly.com.");
        }
    }

    /// <summary>An entry's path with forward slashes, whichever way the zip was written.</summary>
    private static string Name(ZipArchiveEntry entry) => entry.FullName.Replace('\\', '/');

    /// <summary>
    /// bin\termilly.cmd, on PATH without putting agent\ (and its claude shim) there. <c>termilly</c> alone starts
    /// Termilly, <c>termilly &lt;folder&gt;</c> (or <c>termilly .</c>) opens it in that folder, and anything else goes to the
    /// termilly command (list, state, open, send…).
    /// </summary>
    private static void WriteCommandShim(string dir)
    {
        var bin = Path.Combine(dir, InstalledFiles.Bin);
        Directory.CreateDirectory(bin);
        File.WriteAllText(Path.Combine(bin, InstalledFiles.CommandShim), string.Join("\r\n",
            "@echo off",
            "if \"%~1\"==\"\" (",
            "  start \"\" \"%~dp0..\\Termilly.exe\"",
            "  exit /b 0",
            ")",
            "if /i \"%~1\"==\"--open\" (",
            "  start \"\" \"%~dp0..\\Termilly.exe\" --open \"%~f2\"",
            "  exit /b 0",
            ")",
            "if exist \"%~1\\\" (",
            "  start \"\" \"%~dp0..\\Termilly.exe\" --open \"%~f1\"",
            "  exit /b 0",
            ")",
            "\"%~dp0..\\agent\\termilly.exe\" %*",
            "") , Encoding.ASCII);
    }

    private void RegisterWindows(string dir, string exe)
    {
        AddShortcuts(dir, exe);
        using var root = RegistryKey.OpenBaseKey(_options.AllUsers ? RegistryHive.LocalMachine : RegistryHive.CurrentUser, RegistryView.Registry64);
        using (var key = root.CreateSubKey(InstalledTermilly.UninstallKey))
        {
            WriteUninstallEntry(key, dir, exe);
        }
        using (var key = root.CreateSubKey(InstalledTermilly.SetupKey))
        {
            key.SetValue(InstalledTermilly.OptionsValue, _options.ToArgument());
        }
        Log.Write("added the uninstall entry");
    }

    /// <summary>The Start menu and desktop shortcuts, the Explorer menu and PATH, as the options say.</summary>
    private void AddShortcuts(string dir, string exe)
    {
        var all = _options.AllUsers;
        Shell.RemoveExplorerMenu(all);
        Shell.Delete(Shell.DesktopShortcut(all));
        if (_options.StartMenu)
        {
            Shell.CreateShortcut(Shell.StartMenuShortcut(all), exe, "Every shell, SSH host and AI agent in one terminal");
        }
        else
        {
            Shell.Delete(Shell.StartMenuShortcut(all));
        }
        if (_options.Desktop)
        {
            Shell.CreateShortcut(Shell.DesktopShortcut(all), exe, Product.Name);
        }
        if (_options.ExplorerMenu)
        {
            Shell.AddExplorerMenu(all, exe);
        }
        var bin = Path.Combine(dir, InstalledFiles.Bin);
        if (_options.PathCommand)
        {
            Shell.AddToPath(all, bin);
        }
        else
        {
            Shell.RemoveFromPath(all, bin);
        }
    }

    /// <summary>Termilly in Apps &amp; features: its name, version and folder, and how to uninstall or change it.</summary>
    private void WriteUninstallEntry(RegistryKey key, string dir, string exe)
    {
        var setup = Path.Combine(dir, InstalledFiles.Setup);
        key.SetValue("DisplayName", Product.Name);
        key.SetValue(WindowsNames.DisplayVersion, _payload.Version);
        key.SetValue("Publisher", Product.Name);
        key.SetValue("DisplayIcon", $"\"{exe}\",0");
        key.SetValue(WindowsNames.InstallLocation, dir);
        key.SetValue("URLInfoAbout", "https://termilly.com");
        key.SetValue("UninstallString", $"\"{setup}\" {Flags.Uninstall}");
        key.SetValue("QuietUninstallString", $"\"{setup}\" {Flags.Uninstall} {Flags.Quiet}");
        key.SetValue("ModifyPath", $"\"{setup}\"");
        key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
        key.SetValue("EstimatedSize", (int)(Folders.SizeMb(dir) * Bytes.PerKb), RegistryValueKind.DWord);
        key.SetValue("InstallDate", DateTime.Now.ToString("yyyyMMdd", System.Globalization.CultureInfo.InvariantCulture));
    }
}
