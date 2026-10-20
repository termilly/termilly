using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Microsoft.Win32;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>What the user chose on the Options page; remembered in the registry for updates and uninstall.</summary>
internal sealed class SetupOptions
{
    public bool AllUsers { get; set; }
    public string InstallDir { get; set; } = DefaultDir(false);
    public bool StartMenu { get; set; } = true;
    public bool Desktop { get; set; }
    public bool ExplorerMenu { get; set; } = true;
    public bool PathCommand { get; set; } = true;
    public bool AgentIntegration { get; set; } = true;
    public bool BackgroundAtSignIn { get; set; }
    /// <summary>Use setup's own copies of .NET and WebView2 without trying to download them.</summary>
    public bool PreferIncluded { get; set; }
    /// <summary>Done page: start Termilly, and offer its tour on first start.</summary>
    public bool Launch { get; set; } = true;
    public bool Tour { get; set; } = true;

    /// <summary>The per-user programs folder under Local AppData.</summary>
    private const string UserPrograms = "Programs";

    public static string DefaultDir(bool allUsers) => allUsers
        ? Path.Combine(Environment.GetEnvironmentVariable(WindowsNames.ProgramFiles64) ?? Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Product.Name)
        : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), UserPrograms, Product.Name);

    // ---- As command-line text, for the elevated copy of setup and the registry ----

    /// <summary>The options' names in that text: name=value pairs, separated by semicolons.</summary>
    private static class Keys
    {
        public const string AllUsers = "allUsers";
        public const string Dir = "dir";
        public const string StartMenu = "startMenu";
        public const string Desktop = "desktop";
        public const string Explorer = "explorer";
        public const string Path = "path";
        public const string Agent = "agent";
        public const string SignIn = "signIn";
        public const string Included = "included";
        public const string Launch = "launch";
        public const string Tour = "tour";
    }

    private const char Separator = ';';
    private static readonly char[] NameValue = ['='];

    public string ToArgument() => string.Join(Separator.ToString(), new[]
    {
        $"{Keys.AllUsers}={AllUsers}", $"{Keys.Dir}={InstallDir}", $"{Keys.StartMenu}={StartMenu}", $"{Keys.Desktop}={Desktop}",
        $"{Keys.Explorer}={ExplorerMenu}", $"{Keys.Path}={PathCommand}", $"{Keys.Agent}={AgentIntegration}",
        $"{Keys.SignIn}={BackgroundAtSignIn}", $"{Keys.Included}={PreferIncluded}", $"{Keys.Launch}={Launch}", $"{Keys.Tour}={Tour}",
    });

    /// <summary>Options from <see cref="ToArgument"/>'s text; a missing or unreadable one keeps its default.</summary>
    public static SetupOptions FromArgument(string text)
    {
        var values = text.Split(Separator).Select(p => p.Split(NameValue, 2)).Where(p => p.Length == 2)
            .ToDictionary(p => p[0], p => p[1], StringComparer.OrdinalIgnoreCase);
        bool Flag(string name, bool fallback) => values.TryGetValue(name, out var v) && bool.TryParse(v, out var b) ? b : fallback;
        var options = new SetupOptions { AllUsers = Flag(Keys.AllUsers, false) };
        options.InstallDir = values.TryGetValue(Keys.Dir, out var dir) && dir.Length > 0 ? dir : DefaultDir(options.AllUsers);
        options.StartMenu = Flag(Keys.StartMenu, options.StartMenu);
        options.Desktop = Flag(Keys.Desktop, options.Desktop);
        options.ExplorerMenu = Flag(Keys.Explorer, options.ExplorerMenu);
        options.PathCommand = Flag(Keys.Path, options.PathCommand);
        options.AgentIntegration = Flag(Keys.Agent, options.AgentIntegration);
        options.BackgroundAtSignIn = Flag(Keys.SignIn, options.BackgroundAtSignIn);
        options.PreferIncluded = Flag(Keys.Included, options.PreferIncluded);
        options.Launch = Flag(Keys.Launch, options.Launch);
        options.Tour = Flag(Keys.Tour, options.Tour);
        return options;
    }
}

/// <summary>A Termilly that setup installed before: where, which version, for whom, and with which options.</summary>
internal sealed class InstalledTermilly
{
    public const string UninstallKey = @"Software\Microsoft\Windows\CurrentVersion\Uninstall\" + Product.Name;
    public const string SetupKey = @"Software\" + Product.Name + @"\Setup";
    /// <summary>The value under SetupKey with the options the install was made with (SetupOptions.ToArgument).</summary>
    public const string OptionsValue = "Options";
    /// <summary>A version has up to this many parts (1.2.3.4).</summary>
    private const int VersionParts = 4;

    public string Version { get; private set; } = "";
    public string Dir { get; private set; } = "";
    public bool AllUsers { get; private set; }
    public SetupOptions Options { get; private set; } = new();

    /// <summary>The installation this user can see: their own first, then the one for all users.</summary>
    public static InstalledTermilly? Find()
    {
        foreach (var (root, allUsers) in new[] { (Registry.CurrentUser, false), (Registry.LocalMachine, true) })
        {
            using var uninstall = OpenUninstall(root);
            if (uninstall?.GetValue(WindowsNames.InstallLocation) is not string dir || !Directory.Exists(dir))
            {
                continue;
            }
            using var setup = OpenSetup(root);
            var options = setup?.GetValue(OptionsValue) is string text ? SetupOptions.FromArgument(text) : new SetupOptions();
            options.AllUsers = allUsers;
            options.InstallDir = dir;
            return new InstalledTermilly
            {
                Version = uninstall.GetValue(WindowsNames.DisplayVersion) as string ?? "",
                Dir = dir,
                AllUsers = allUsers,
                Options = options,
            };
        }
        return null;
    }

    private static RegistryKey? OpenUninstall(RegistryKey root) =>
        RegistryKey.OpenBaseKey(root == Registry.CurrentUser ? RegistryHive.CurrentUser : RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(UninstallKey);

    private static RegistryKey? OpenSetup(RegistryKey root) =>
        RegistryKey.OpenBaseKey(root == Registry.CurrentUser ? RegistryHive.CurrentUser : RegistryHive.LocalMachine, RegistryView.Registry64).OpenSubKey(SetupKey);

    /// <summary>Compares "1.0.0"-style versions; unknown parts count as 0.</summary>
    public static int CompareVersions(string a, string b)
    {
        static int[] Parts(string v) => (v ?? "").Split('.').Select(p => int.TryParse(p, out var n) ? n : 0).Concat(Enumerable.Repeat(0, VersionParts)).Take(VersionParts).ToArray();
        return Parts(a).Zip(Parts(b), (x, y) => x.CompareTo(y)).FirstOrDefault(c => c != 0);
    }

    public static IEnumerable<string> Describe(SetupOptions o)
    {
        if (o.StartMenu)
        {
            yield return "Start menu shortcut";
        }
        if (o.Desktop)
        {
            yield return "desktop shortcut";
        }
        if (o.ExplorerMenu)
        {
            yield return "Explorer menu";
        }
        if (o.PathCommand)
        {
            yield return "termilly on PATH";
        }
    }
}
