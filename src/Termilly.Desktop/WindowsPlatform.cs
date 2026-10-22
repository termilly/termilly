using System.Diagnostics;
using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;

namespace Termilly.Desktop;

/// <summary>
/// What Windows does for the shared code (Platform/), around <see cref="MainWindow"/>: WebView2 messages, the
/// window, the system's dialogs, Explorer, toasts, the taskbar badge, the ports terminals listen on and starting the
/// background host at sign-in. Calls may come from any thread; what touches the window runs on its thread.
/// </summary>
internal sealed class WindowsPlatform(MainWindow window) :
    IPageSink, IAppWindow, IFileDialogs, IDesktopShell, INotifier, ISystemProcesses, ISignInStart, ISystemTheme
{
    /// <summary>Where Windows keeps whether apps use the light theme (1) or the dark one.</summary>
    private const string PersonalizeKey = @"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Themes\Personalize";
    private const string AppsUseLightTheme = "AppsUseLightTheme";

    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string RunValue = "Termilly background shells";
    private const string BrowserEngine = "msedgewebview2.exe";
    private const string Explorer = "explorer.exe";

    private Notifications? _notifications;

    public event Action<string>? Clicked;

    public void Send(string json) => window.Dispatcher.InvokeAsync(() => window.PostToPage(json));

    public bool PrefersLight => Microsoft.Win32.Registry.GetValue(PersonalizeKey, AppsUseLightTheme, 0) is 1;

    // ---- The window ----

    public string? StartFolder => App.StartFolder;

    public void BringToFront() => window.Dispatcher.InvokeAsync(window.BringToFront);

    public void Act(FromPage.Window action) => window.HandleWindowAction(action);

    public void CloseNow() => window.Dispatcher.BeginInvoke(window.CloseOnce);

    public void ShowBadge(int count) => window.ShowBadge(count);

    public void PageReady() => window.RevealPage();

    // ---- Dialogs: the page's messages arrive on the window's thread, so they open there and answer at once ----

    public Task<string?> PickFolderAsync(string title, string initial)
    {
        var dialog = new Microsoft.Win32.OpenFolderDialog { Title = title, InitialDirectory = initial };
        return Task.FromResult(dialog.ShowDialog(window) == true ? dialog.FolderName : null);
    }

    public Task<string?> PickLayoutToSaveAsync(string fileName)
    {
        var dialog = new Microsoft.Win32.SaveFileDialog
        {
            Title = "Export workspace layout",
            FileName = fileName,
            Filter = "Termilly layout (*.yml)|*.yml|All files (*.*)|*.*",
            DefaultExt = WorkspaceLayout.Extension,
        };
        return Task.FromResult(dialog.ShowDialog(window) == true ? dialog.FileName : null);
    }

    public Task<string?> PickLayoutToOpenAsync()
    {
        var dialog = new Microsoft.Win32.OpenFileDialog
        {
            Title = "Import workspace layout",
            Filter = "Termilly layout (*.yml;*.yaml)|*.yml;*.yaml|All files (*.*)|*.*",
        };
        return Task.FromResult(dialog.ShowDialog(window) == true ? dialog.FileName : null);
    }

    /// <summary>Never asked on Windows: the page's file input gives the files' paths.</summary>
    public Task<IReadOnlyList<string>> PickFilesAsync(string title) => Task.FromResult<IReadOnlyList<string>>([]);

    // ---- Explorer and the browser ----

    public void OpenFolder(string folder) => Process.Start(new ProcessStartInfo(Explorer, $"\"{folder}\"") { UseShellExecute = true });

    public void RevealFile(string file) => Process.Start(new ProcessStartInfo(Explorer, $"/select,\"{file}\"") { UseShellExecute = true });

    public void OpenUrl(Uri url) => Process.Start(new ProcessStartInfo(url.AbsoluteUri) { UseShellExecute = true });

    // ---- Toasts ----

    public void Notify(string terminal, string title, string body)
    {
        _notifications ??= new Notifications(clicked => Clicked?.Invoke(clicked));
        _notifications.Show(terminal, title, body);
    }

    public void Withdraw(string terminal) => _notifications?.Withdraw(terminal);

    // ---- Processes ----

    public IReadOnlyDictionary<string, int[]> TerminalPorts(IReadOnlyDictionary<string, int> sessionPids) =>
        ListeningPorts.ByTerminal(Ports.Listening().Select(l => (l.Pid, l.Port)), ListeningPorts.TerminalOwners(sessionPids, Ports.ParentIds()));

    public bool IsBrowserEngine(ProcessEntry process) => process.Exe.Equals(BrowserEngine, StringComparison.OrdinalIgnoreCase);

    // ---- Sign-in ----

    /// <summary>Starts the background host at Windows sign-in (HKCU Run), or stops doing so.</summary>
    public void Set(bool wanted, string hostExe)
    {
        try
        {
            using var run = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(RunKey, writable: true);
            var present = run?.GetValue(RunValue) is not null;
            if (wanted && !present)
            {
                run?.SetValue(RunValue, $"\"{hostExe}\"");
            }
            else if (!wanted && present)
            {
                run?.DeleteValue(RunValue, throwOnMissingValue: false);
            }
        }
        catch (Exception e) when (e is UnauthorizedAccessException or System.Security.SecurityException or IOException)
        {
            // Left as it was; Settings still shows the choice.
        }
    }
}
