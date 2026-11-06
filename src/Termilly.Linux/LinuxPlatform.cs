using Termilly.Desktop;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// What Linux does for the shared code (Platform/): GTK dialogs through Photino, xdg-open, the file manager over
/// D-Bus, notify-send, the ports terminals listen on from /proc, and the background host started at sign-in by an
/// XDG autostart entry. The window and its dialogs are <see cref="PhotinoPlatform"/>'s.
/// </summary>
internal sealed class LinuxPlatform(Action<string> send, string? startFolder) :
    PhotinoPlatform(send, startFolder), IDesktopShell, INotifier, ISystemProcesses, ISignInStart, ISystemTheme
{
    /// <summary>What a dark colour scheme's name has in it ("prefer-dark").</summary>
    private const string DarkScheme = "dark";
    private static readonly string[] ColorSchemeQuery = ["get", "org.gnome.desktop.interface", "color-scheme"];

    private const string AutostartEntry = "termilly-host.desktop";
    private const string BrowserEngine = "WebKit";
    /// <summary>user-dirs.dirs' line naming the Downloads folder, and how its paths start in the home folder.</summary>
    private const string DownloadDirKey = "XDG_DOWNLOAD_DIR=";
    private const string HomePrefix = "$HOME/";
    /// <summary>The Downloads folder's usual name, when the desktop doesn't name another.</summary>
    private const string DownloadsName = "Downloads";
    /// <summary>Opens a folder or link with what the desktop chose for it.</summary>
    private const string XdgOpen = "xdg-open";

    /// <summary>GNOME's (and most desktops') colour scheme: "prefer-dark" or "default"/"prefer-light".</summary>
    public bool PrefersLight => Query("gsettings", ColorSchemeQuery) is { } scheme &&
                                !scheme.Contains(DarkScheme, StringComparison.OrdinalIgnoreCase);

    /// <summary>notify-send's notifications can't be clicked through to a terminal, so this never fires.</summary>
    public event Action<string>? Clicked
    {
        add { }
        remove { }
    }

    /// <summary>Where the desktop's settings are: XDG_CONFIG_HOME, else ~/.config.</summary>
    private static string ConfigHome =>
        Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") is { Length: > 0 } config ? config : Path.Combine(Home, ".config");

    // ---- The file manager and the browser ----

    public void OpenFolder(string folder) => Run(XdgOpen, folder);

    /// <summary>The file manager with the file selected (org.freedesktop.FileManager1: Nautilus, Dolphin, Nemo…), else its folder.</summary>
    public void RevealFile(string file)
    {
        var uri = new Uri(file).AbsoluteUri.Replace("'", "%27");
        if (!Run("gdbus", "call", "--session", "--dest", "org.freedesktop.FileManager1", "--object-path", "/org/freedesktop/FileManager1",
                "--method", "org.freedesktop.FileManager1.ShowItems", $"['{uri}']", ""))
        {
            OpenFolder(Path.GetDirectoryName(file)!);
        }
    }

    public void OpenFile(string file) => Run(XdgOpen, file);

    /// <summary>The desktop's trash (gio trash: GNOME's, which KDE and the others read too).</summary>
    public void Trash(string path)
    {
        try
        {
            RunToEnd("gio", $"Couldn't move {Path.GetFileName(path)} to the trash.", "trash", "--", path);
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new IOException("Moving to the trash needs gio (the glib2 tools).");
        }
    }

    /// <summary>XDG_DOWNLOAD_DIR from ~/.config/user-dirs.dirs (it's named in the desktop's language), else ~/Downloads.</summary>
    public string DownloadsFolder
    {
        get
        {
            var dirs = Path.Combine(ConfigHome, "user-dirs.dirs");
            try
            {
                return DownloadsIn(File.Exists(dirs) ? File.ReadAllText(dirs) : "", Home);
            }
            catch (Exception e) when (Storage.IsFileError(e))
            {
                return DownloadsIn("", Home);
            }
        }
    }

    /// <summary>The Downloads folder a user-dirs.dirs names (XDG_DOWNLOAD_DIR="$HOME/Downloads"), else ~/Downloads.</summary>
    internal static string DownloadsIn(string userDirs, string home)
    {
        var line = userDirs.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith(DownloadDirKey, StringComparison.Ordinal));
        var value = line?[DownloadDirKey.Length..].Trim('"');
        if (string.IsNullOrEmpty(value) || value == "$HOME" || value == HomePrefix)
        {
            return Path.Combine(home, DownloadsName);
        }
        return value.StartsWith(HomePrefix, StringComparison.Ordinal) ? Path.Combine(home, value[HomePrefix.Length..]) : value;
    }

    public void OpenUrl(Uri url) => Run(XdgOpen, url.AbsoluteUri);

    // ---- Notifications ----

    public void Notify(string terminal, string title, string body) =>
        Run("notify-send", "--app-name=Termilly", "--icon=termilly", title, body);

    /// <summary>notify-send's notifications can't be taken back.</summary>
    public void Withdraw(string terminal)
    {
    }

    // ---- Processes ----

    public IReadOnlyDictionary<string, int[]> TerminalPorts(IReadOnlyDictionary<string, int> sessionPids) =>
        ListeningPorts.ByTerminal(LinuxPorts.Listening().Select(l => (l.Pid, l.Port)), ListeningPorts.TerminalOwners(sessionPids, LinuxPorts.ParentIds()));

    public bool IsBrowserEngine(ProcessEntry process) => process.Exe.StartsWith(BrowserEngine, StringComparison.Ordinal);

    // ---- Sign-in ----

    /// <summary>
    /// Starts the background host at sign-in, or stops doing so: an XDG autostart entry, which GNOME, KDE and the
    /// others run when the user signs in.
    /// </summary>
    public void Set(bool wanted, string hostExe)
    {
        var folder = Path.Combine(ConfigHome, "autostart");
        var entry = Path.Combine(folder, AutostartEntry);
        try
        {
            if (wanted)
            {
                var text = $"""
                    [Desktop Entry]
                    Type=Application
                    Name=Termilly background shells
                    Comment=Keeps Termilly's shells running while its window is closed
                    Exec="{hostExe}"
                    Icon=termilly
                    Terminal=false
                    NoDisplay=true
                    X-GNOME-Autostart-enabled=true

                    """;
                if (!File.Exists(entry) || File.ReadAllText(entry) != text)
                {
                    AppPaths.WriteAtomically(entry, text);
                }
            }
            else if (File.Exists(entry))
            {
                File.Delete(entry);
            }
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // Left as it was; Settings still shows the choice.
        }
    }
}
