using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Web.WebView2.Core;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Termilly's window on Windows: WebView2 showing the page, with its own title bar and the start-up loader. What the
/// page asks for is answered by <see cref="PageHost"/> (shared with Linux), with what Windows does its own way in
/// <see cref="WindowsPlatform"/>; this window adds the taskbar badge, global hotkeys and quake mode. It is the
/// composition root on Windows: it builds the services once it exists.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "WPF never disposes a window: OnClosing disposes what it owns.")]
public partial class MainWindow : Window
{
    private const string HostName = "termilly.local";

    private readonly ServiceProvider _services;
    private readonly ISettingsStore _settings;
    private readonly PageChannel _channel;
    private readonly PageHost _page;
    private readonly WindowTheme _theme;
    private GlobalHotkeys? _hotkeys;
    private int _badgeCount;
    private int? _jumpHotkey;
    private int? _quakeHotkey;
    private string? _quakeChord;
    private QuakeMode? _quake;

    /// <summary>The system-wide chord for "next terminal that needs me" (Settings › Terminal).</summary>
    public const string JumpChord = "Ctrl+Alt+J";
    /// <summary>The start-up screen shows at least this long before the page is shown anyway.</summary>
    private static readonly TimeSpan RevealTimeout = TimeSpan.FromSeconds(12);
    private static readonly TimeSpan RevealFade = TimeSpan.FromMilliseconds(160);
    /// <summary>How long a closing window waits for the page's last snapshot.</summary>
    private static readonly TimeSpan SnapshotWait = TimeSpan.FromSeconds(1.5);
    private const string WebViewFolder = "WebView2";
    /// <summary>Settings keep the drop-down window's height in percent.</summary>
    private const double Percent = 100.0;
    private readonly StartupLoader _loader;
    private WindowPlacement.Target? _target;
    private readonly DispatcherTimer _revealFallback;
    private bool _closing;

    public MainWindow()
    {
        _services = new ServiceCollection()
            .AddTermilly()
            .AddPlatform(new WindowsPlatform(this))
            .AddSingleton<ICredentialStore, WindowsCredentialStore>()
            .AddSingleton<IFontCatalog, WindowsFonts>()
            .BuildServiceProvider();
        _settings = _services.GetRequiredService<ISettingsStore>();
        _channel = _services.GetRequiredService<PageChannel>();
        _page = _services.GetRequiredService<PageHost>();
        _theme = _services.GetRequiredService<WindowTheme>();
        _settings.Saved += _ =>
        {
            ApplyTheme();
            UpdateGlobalHotkeys();
        };
        InitializeComponent();
        WindowInterop.UseCustomChrome(this);
        // Termilly opens where the window was last closed (maximized, if it was), on the start-up screen until the
        // page is ready (RevealPage).
        SourceInitialized += (_, _) => WindowPlacement.Restore(this, _target = WindowPlacement.Plan(new Size(MinWidth, MinHeight)));
        Stage.SizeChanged += (_, _) => FitPageToWindow();
        ApplyTheme();

        _loader = new StartupLoader(LoaderMark, LoaderText, LoaderCaret);
        _loader.ShowMark(VisualTreeHelper.GetDpi(this).DpiScaleX);
        DpiChanged += (_, e) => _loader.ShowMark(e.NewDpi.DpiScaleX);
        Loader.MouseLeftButtonDown += (_, _) => DragMove();
        _loader.Start();

        // Never leave the window stuck on the start-up screen, even if the page fails to report in.
        _revealFallback = new DispatcherTimer { Interval = RevealTimeout };
        _revealFallback.Tick += (_, _) => RevealPage();
        _revealFallback.Start();

        Loaded += async (_, _) =>
        {
            _hotkeys = new GlobalHotkeys(this);
            _page.Start();
            _quake = new QuakeMode(this, down => _channel.Post(new ToPage.Quake(down)));
            UpdateGlobalHotkeys();
            await InitializeWebViewAsync();
        };
    }

    private AppSettings Settings => _settings.Current;

    /// <summary>
    /// Colours the window and start-up screen to match the page's theme, so a light theme doesn't start with a black
    /// flash. Matches --bg, --text and --accent in app.css.
    /// </summary>
    private void ApplyTheme()
    {
        var colors = _theme.Palette;
        var background = Brush(colors.Background);
        WindowInterop.Background = colors.Background;
        Background = background;
        Loader.Background = background;
        // No frame while starting: the start-up screen may fill the whole screen (a window closed maximized).
        // The frame is drawn in the background's colour rather than taken away, so the page keeps its size.
        Frame.BorderBrush = Loader.Visibility == Visibility.Visible ? background : Brush(colors.Frame);
        LoaderText.Foreground = Brush(colors.Text);
        LoaderCaret.Fill = Brush(colors.Accent);
        Web.DefaultBackgroundColor = System.Drawing.ColorTranslator.FromHtml(colors.Background);
    }

    private static SolidColorBrush Brush(string hex) => (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;

    /// <summary>
    /// Once the page says it's ready: the start-up screen fades, then the page, already at the window's size, takes
    /// its place.
    /// </summary>
    internal void RevealPage()
    {
        _revealFallback.Stop();
        if (_target is not { } target)
        {
            return;
        }
        _target = null;
        var fade = new System.Windows.Media.Animation.DoubleAnimation(0, RevealFade);
        fade.Completed += (_, _) =>
        {
            Canvas.SetLeft(Web, 0);
            Canvas.SetTop(Web, 0);
            Loader.Visibility = Visibility.Collapsed;
            _loader.Stop();
            Frame.BorderBrush = Brush(_theme.Palette.Frame);
            Activate();
            Web.Focus();
        };
        LoaderBox.BeginAnimation(OpacityProperty, fade);
    }

    private void FitPageToWindow()
    {
        Web.Width = Stage.ActualWidth;
        Web.Height = Stage.ActualHeight;
    }

    private async Task InitializeWebViewAsync()
    {
        try
        {
            CoreWebView2EnvironmentOptions? options = null;
#if DEBUG
            // Debug builds only: TERMILLY_DEVTOOLS_PORT opens the page to the DevTools protocol, for live tests
            // against a throwaway instance (TERMILLY_DATA_DIR). WebView2 doesn't always honour its own variable.
            if (int.TryParse(Environment.GetEnvironmentVariable("TERMILLY_DEVTOOLS_PORT"), out var devtoolsPort))
            {
                options = new CoreWebView2EnvironmentOptions($"--remote-debugging-port={devtoolsPort}");
            }
#endif
            var env = await CoreWebView2Environment.CreateAsync(
                userDataFolder: Path.Combine(AppPaths.DataDirectory, WebViewFolder), options: options);
            await Web.EnsureCoreWebView2Async(env);
        }
        catch (WebView2RuntimeNotFoundException)
        {
            RevealPage();
            MessageBox.Show(this, "The Microsoft Edge WebView2 Runtime is required.", Product.Name);
            Close();
            return;
        }

        var core = Web.CoreWebView2;
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // let F5, Ctrl+F etc. reach the terminal
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.SetVirtualHostNameToFolderMapping(
            HostName, AppPaths.WebRoot, CoreWebView2HostResourceAccessKind.Deny);
        core.WebMessageReceived += OnWebMessage;
        core.PermissionRequested += OnPermissionRequested;
        core.NavigationCompleted += (_, _) => PostWindowState();
        core.Navigate($"https://{HostName}/index.html");
    }

    /// <summary>
    /// The terminal's right-click Paste reads the clipboard, which WebView2 would otherwise ask about each time. Only
    /// Termilly's own page gets it (a plugin's sandboxed frame has an opaque origin of its own).
    /// </summary>
    private static void OnPermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs e)
    {
        if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead
            && e.Uri.StartsWith($"https://{HostName}/", StringComparison.OrdinalIgnoreCase))
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
    }

    private void OnWebMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        // Only Termilly's own page talks to the host (not a plugin's sandboxed frame, nor anything navigated to).
        if (!e.Source.StartsWith($"https://{HostName}/", StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        using var doc = JsonDocument.Parse(e.WebMessageAsJson);
        // Dropped or picked files come with the message, with their real paths (files:drop, sftp:put).
        var files = e.AdditionalObjects?.OfType<CoreWebView2File>().Select(f => f.Path).ToList();
        _page.OnMessage(doc.RootElement, files);
    }

    /// <summary>A message for the page, on the window's thread; dropped once the window is closing.</summary>
    internal void PostToPage(string json)
    {
        if (!_closing)
        {
            Web.CoreWebView2?.PostWebMessageAsJson(json);
        }
    }

    internal void HandleWindowAction(FromPage.Window msg)
    {
        switch (msg.Action)
        {
            case WindowActions.Minimize:
                WindowState = WindowState.Minimized;
                break;
            case WindowActions.Maximize:
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                break;
            case WindowActions.Close:
                Close();
                break;
            case WindowActions.Drag:
                WindowInterop.BeginNonClientDrag(this, WindowInterop.HTCAPTION);
                break;
            case WindowActions.Resize:
                if (WindowState == WindowState.Normal && msg.Edge is { } edge &&
                    WindowInterop.EdgeHitTests.TryGetValue(edge, out var hitTest))
                {
                    WindowInterop.BeginNonClientDrag(this, hitTest);
                }
                break;
        }
    }

    protected override void OnStateChanged(EventArgs e)
    {
        base.OnStateChanged(e);
        Frame.BorderThickness = new Thickness(WindowState == WindowState.Maximized ? 0 : 1);
        PostWindowState();
    }

    protected override void OnActivated(EventArgs e)
    {
        base.OnActivated(e);
        PostWindowState();
    }

    protected override void OnDeactivated(EventArgs e)
    {
        base.OnDeactivated(e);
        PostWindowState();
    }

    private void PostWindowState() => _channel.Post(new ToPage.WindowState(
        WindowState == WindowState.Maximized, WindowState == WindowState.Minimized, IsActive && WindowState != WindowState.Minimized));

    /// <summary>
    /// Registers or drops the system-wide "next terminal that needs me" shortcut. It brings Termilly forward and
    /// lets the page pick the terminal. If another app owns the chord, the page is told so Settings can say.
    /// </summary>
    private void UpdateGlobalHotkeys()
    {
        if (_hotkeys is null)
        {
            return;
        }
        if (Settings.Notifications.JumpHotkey && _jumpHotkey is null)
        {
            _jumpHotkey = _hotkeys.Register(JumpChord, () =>
            {
                BringToFront();
                _channel.Post(new ToPage.AgentsNext());
            });
            if (_jumpHotkey is null)
            {
                _channel.Post(new ToPage.HotkeyTaken(JumpChord));
            }
        }
        else if (!Settings.Notifications.JumpHotkey && _jumpHotkey is not null)
        {
            _hotkeys.Unregister(_jumpHotkey);
            _jumpHotkey = null;
        }

        // The drop-down window's shortcut (Settings › Window); a new chord replaces the old one.
        var quakeChord = Settings.Quake.Enabled ? Settings.Quake.Chord : null;
        if (quakeChord != _quakeChord)
        {
            _hotkeys.Unregister(_quakeHotkey);
            _quakeHotkey = null;
            _quakeChord = quakeChord;
            if (quakeChord is not null)
            {
                _quakeHotkey = _hotkeys.Register(quakeChord, () => _quake?.Toggle());
                if (_quakeHotkey is null)
                {
                    _channel.Post(new ToPage.HotkeyTaken(quakeChord));
                }
            }
        }
        if (_quake is not null)
        {
            _quake.Height = Settings.Quake.Height / Percent;
            _quake.AutoHide = Settings.Quake.AutoHide;
            if (!Settings.Quake.Enabled)
            {
                _quake.Leave();
            }
        }
    }

    /// <summary>The taskbar button's overlay (TaskbarBadge): how many terminals need the user, none when nothing does.</summary>
    internal void ShowBadge(int count)
    {
        if (count == _badgeCount)
        {
            return;
        }
        _badgeCount = count;
        TaskbarItemInfo ??= new System.Windows.Shell.TaskbarItemInfo();
        if (count <= 0)
        {
            TaskbarItemInfo.Overlay = null;
            TaskbarItemInfo.Description = Product.Name;
            return;
        }

        TaskbarItemInfo.Overlay = TaskbarBadge.Render(count);
        TaskbarItemInfo.Description = $"Termilly: {count} terminal{(count == 1 ? " needs" : "s need")} you";
    }

    /// <summary>Shows the window on top, restoring it from the taskbar if needed.</summary>
    internal void BringToFront()
    {
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }
        Show();
        Activate();
        Web.Focus();
    }

    /// <summary>Closes unless already closing (the page's last snapshot and the time limit can both ask).</summary>
    internal void CloseOnce()
    {
        if (!_closing)
        {
            Close();
        }
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // Ask the page for a last snapshot of what the terminals show, then close when it arrives (or after a
        // moment, if the page doesn't answer).
        if (_page.WantsLastSnapshot && Web.CoreWebView2 is not null)
        {
            e.Cancel = true;
            _page.RequestSnapshot();
            var fallback = new DispatcherTimer { Interval = SnapshotWait };
            fallback.Tick += (_, _) =>
            {
                fallback.Stop();
                CloseOnce();
            };
            fallback.Start();
            return;
        }
        _closing = true;
        // The drop-down terminal's place is the quake mode's, not the window's: keep the last normal one.
        if (_quake?.Active != true)
        {
            WindowPlacement.Save(this);
        }
        _hotkeys?.Dispose();
        _services.Dispose(); // the page's host goes; shells the background host runs keep running
        base.OnClosing(e);
    }

    /// <summary>"Leave drop-down mode": back to a normal window.</summary>
    internal void LeaveQuake() => _quake?.Leave();
}
