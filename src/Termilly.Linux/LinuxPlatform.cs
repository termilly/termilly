using System.Diagnostics;
using Photino.NET;
using Termilly.Desktop;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// What Linux does for the shared code (Platform/): GTK dialogs through Photino, xdg-open, the file manager over
/// D-Bus, notify-send, the ports terminals listen on from /proc, and the background host started at sign-in by an
/// XDG autostart entry. The window itself is Program's: what it has to do is raised as events.
/// </summary>
/// <param name="send">Sends a message to the page (Program's outbox, so sending never waits on the window's thread).</param>
internal sealed class LinuxPlatform(Action<string> send, string? startFolder) :
    IPageSink, IAppWindow, IFileDialogs, IDesktopShell, INotifier, ISystemProcesses, ISignInStart, ISystemTheme
{
    /// <summary>What a dark colour scheme's name has in it ("prefer-dark").</summary>
    private const string DarkScheme = "dark";
    /// <summary>How long gsettings may take.</summary>
    private static readonly TimeSpan SystemQueryTimeout = TimeSpan.FromSeconds(5);

    private const string AutostartEntry = "termilly-host.desktop";
    private const string BrowserEngine = "WebKit";
    /// <summary>Opens a folder or link with what the desktop chose for it.</summary>
    private const string XdgOpen = "xdg-open";

    private PhotinoWindow? _window;

    /// <summary>GNOME's (and most desktops') colour scheme: "prefer-dark" or "default"/"prefer-light".</summary>
    public bool PrefersLight => Query("gsettings", "get org.gnome.desktop.interface color-scheme") is { } scheme &&
                                !scheme.Contains(DarkScheme, StringComparison.OrdinalIgnoreCase);

    private static string? Query(string file, string arguments)
    {
        try
        {
            using var process = Process.Start(new ProcessStartInfo(file, arguments) { RedirectStandardOutput = true, UseShellExecute = false });
            var output = process!.StandardOutput.ReadToEnd();
            process.WaitForExit(SystemQueryTimeout);
            return output;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>The window's title bar asks for a window action (minimize, maximize, close, drag, resize).</summary>
    public event Action<FromPage.Window>? WindowActionRequested;

    /// <summary>Termilly was started again while this one runs: the window should come to the front.</summary>
    public event Action? Activate;

    /// <summary>The page's last snapshot is in: the window can close now.</summary>
    public event Action? CloseRequested;

    /// <summary>notify-send's notifications can't be clicked through to a terminal, so this never fires.</summary>
    public event Action<string>? Clicked
    {
        add { }
        remove { }
    }

    /// <summary>The window, for its dialogs; set once it exists.</summary>
    public void Attach(PhotinoWindow window) => _window = window;

    public void Send(string json) => send(json);

    // ---- The window ----

    public string? StartFolder => startFolder;

    public void BringToFront() => Activate?.Invoke();

    public void Act(FromPage.Window action) => WindowActionRequested?.Invoke(action);

    public void CloseNow() => CloseRequested?.Invoke();

    /// <summary>No dock badge on Linux yet (src/Termilly.Linux/README.md, "Not yet").</summary>
    public void ShowBadge(int count)
    {
    }

    /// <summary>The page shows its own start-up screen (js/loader.js): nothing to take away.</summary>
    public void PageReady()
    {
    }

    public void RegisterMessages(MessageRouter router)
    {
    }

    // ---- GTK's own dialogs, through Photino: they open on the window's thread; the answer comes back here ----

    private static string Home => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    public async Task<string?> PickFolderAsync(string title, string initial) =>
        _window is null ? null : (await _window.ShowOpenFolderAsync(title, initial, false).ConfigureAwait(false))?.FirstOrDefault();

    public async Task<string?> PickLayoutToSaveAsync(string fileName)
    {
        if (_window is null)
        {
            return null;
        }
        var path = await _window.ShowSaveFileAsync("Export workspace layout", Path.Combine(Home, fileName), [("Termilly layout", ["*" + WorkspaceLayout.Extension])]).ConfigureAwait(false);
        return string.IsNullOrEmpty(path) ? null : path;
    }

    public async Task<string?> PickLayoutToOpenAsync() =>
        _window is null
            ? null
            : (await _window.ShowOpenFileAsync("Import workspace layout", Home, false,
                [("Termilly layout", ["*" + WorkspaceLayout.Extension, "*.yaml"]), ("All files", ["*"])]).ConfigureAwait(false))?.FirstOrDefault();

    public async Task<IReadOnlyList<string>> PickFilesAsync(string title) =>
        _window is null ? [] : await _window.ShowOpenFileAsync(title, Home, true).ConfigureAwait(false) ?? [];

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
        var folder = Path.Combine(Environment.GetEnvironmentVariable("XDG_CONFIG_HOME") is { Length: > 0 } config
            ? config
            : Path.Combine(Home, ".config"), "autostart");
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

    /// <summary>Starts a program without waiting for it; false when it couldn't be started.</summary>
    private static bool Run(string file, params string[] args)
    {
        try
        {
            var start = new ProcessStartInfo(file) { UseShellExecute = false };
            foreach (var arg in args)
            {
                start.ArgumentList.Add(arg);
            }
            Process.Start(start)?.Dispose();
            return true;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            Console.Error.WriteLine($"termilly: {file}: {e.Message}");
            return false;
        }
    }
}
