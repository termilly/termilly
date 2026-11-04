using System.Collections.Concurrent;
using System.Drawing;
using System.Text.Json;
using Photino.NET;
using Termilly.Desktop;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// The Photino window and its page: messages both ways, the window's state for the page, and what the page (through
/// <see cref="PhotinoPlatform"/>) asks of the window. Linux and macOS alike.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "Lives as long as the app; the outbox thread may still be finishing at exit.")]
internal sealed class LinuxWindow
{
    private static readonly Size StartSize = new(1280, 820);
    /// <summary>Center() misplaces the window under XWayland.</summary>
    private static readonly Point StartLocation = new(80, 60);
    private const int MinWidth = 480;
    private const int MinHeight = 320;
    /// <summary>How long a closing window waits for the page's last snapshot.</summary>
    private static readonly TimeSpan SnapshotWait = TimeSpan.FromMilliseconds(1500);
    private static readonly Uri StartPage = new($"{AppScheme.Scheme}://localhost/{AppScheme.IndexPage}");
    private const string DevToolsVariable = "TERMILLY_DEVTOOLS";

    // Messages to the page go through one queue, in order, so sending never waits for the window's thread (as
    // Dispatcher.InvokeAsync on Windows): Photino's Invoke blocks until that thread runs it, and the window's thread
    // may itself be waiting on whoever is sending (a shell starting in the background host).
    private readonly BlockingCollection<string> _outbox = new(); // not disposed: its thread may still be finishing at exit
    private PhotinoWindow? _window;
    // As on Windows, messages before the window (and its page) exist are dropped.
    private volatile bool _created;
    private volatile bool _closing;
    // The window's state the page last heard (see PostState): it starts in front.
    private volatile bool _minimized;
    private volatile bool _active = true;
    /// <summary>The whole app's size in percent (Settings' zoom), for the window and its page's own windows.</summary>
    private volatile int _zoom = InterfaceSettings.DefaultZoom;

    /// <summary>
    /// The whole app's size changed (Settings' zoom, Ctrl+Shift+= and -): the page, and on Linux the page's own windows,
    /// at that size. Before the window opens, it opens so.
    /// </summary>
    public void SetZoom(int percent)
    {
        _zoom = percent;
        if (_window is { } window && _created)
        {
            window.Invoke(() => ApplyZoom(window));
        }
    }

    private void ApplyZoom(PhotinoWindow window)
    {
        if (OperatingSystem.IsLinux())
        {
            window.SetZoom(_zoom);
            DetachedWindows.SetZoom(_zoom / (double)InterfaceSettings.DefaultZoom);
        }
        else if (OperatingSystem.IsMacOS())
        {
            // Not Photino's zoom: on macOS it magnifies the page past its window (MacWindows lays it out again).
            MacWindows.SetZoom(_zoom / (double)InterfaceSettings.DefaultZoom);
        }
    }

    public LinuxWindow() => new Thread(SendLoop) { IsBackground = true, Name = "page-outbox" }.Start();

    /// <summary>Queues a message for the page; dropped once the window has closed.</summary>
    public void Send(string json)
    {
        try
        {
            _outbox.Add(json);
        }
        catch (InvalidOperationException)
        {
            // The window has closed: nobody to tell.
        }
    }

    /// <summary>Shows the window and returns when it has closed.</summary>
    public void Run(PhotinoPlatform platform, WindowTheme theme, PageChannel channel, PageHost host, QuitGate quit)
    {
        var window = _window = Create(theme, channel, host, quit);
        var icon = Path.Combine(AppContext.BaseDirectory, "icons", "hicolor", "256x256", "apps", "termilly.png");
        if (File.Exists(icon))
        {
            window.SetIconFile(icon);
        }
        Follow(platform, window, channel, quit);
        host.Start();
        window.Load(StartPage);
        window.WaitForClose();
        _outbox.CompleteAdding();
    }

    private void SendLoop()
    {
        foreach (var json in _outbox.GetConsumingEnumerable())
        {
            if (_created && !_closing)
            {
                _window?.Invoke(() => _window.SendWebMessage(json));
            }
        }
    }

    private PhotinoWindow Create(WindowTheme theme, PageChannel channel, PageHost host, QuitGate quit)
    {
        PhotinoWindow? window = null;
        // LogVerbosity 0: Photino otherwise prints every message to and from the page, settings and scrollback included.
        window = new PhotinoWindow { LogVerbosity = 0 }
            .SetTitle(GtkWindow.Title)
            .SetUseOsDefaultSize(false)
            .SetSize(StartSize)
            .SetLocation(StartLocation)
            .SetResizable(true)
            .SetChromeless(true)
            // Linux: see-through, so the page's rounded corners (app.css, data-corners) show the desktop behind them.
            .SetTransparent(OperatingSystem.IsLinux())
            .SetZoom(OperatingSystem.IsMacOS() ? InterfaceSettings.DefaultZoom : _zoom)
            .SetMinSize(MinWidth, MinHeight)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable(DevToolsVariable) == "1")
            .SetContextMenuEnabled(false)
            .RegisterCustomSchemeHandler(AppScheme.Scheme, (object _, string _, string url, out string contentType) => AppScheme.Serve(url, theme.Palette, out contentType))
            .RegisterWindowCreatedHandler((_, _) => OnCreated(window!, channel))
            .RegisterWebMessageReceivedHandler((_, message) =>
            {
                using var doc = JsonDocument.Parse(message);
                host.OnMessage(doc.RootElement);
            })
            .RegisterMaximizedHandler((_, _) => PostState(channel, window!, minimized: false))
            .RegisterRestoredHandler((_, _) => PostState(channel, window!, minimized: false))
            .RegisterMinimizedHandler((_, _) => PostState(channel, window!, minimized: true))
            .RegisterFocusInHandler((_, _) => PostState(channel, window!, active: true))
            .RegisterFocusOutHandler((_, _) => PostState(channel, window!, active: false))
            .RegisterWindowClosingHandler((_, _) => Closing(window!, host, quit));
        return window;
    }

    /// <summary>The window is asked to close: true keeps it open for now.</summary>
    private bool Closing(PhotinoWindow window, PageHost host, QuitGate quit)
    {
        // As on Windows: Close asks before quitting while something runs (QuitGate)…
        if (!quit.Quitting)
        {
            quit.Ask(() => window.Invoke(() => window.Close()));
            return true; // keep the window open for now
        }
        // …and with terminals to keep, the page first sends a last snapshot, then the window closes.
        if (host.WantsLastSnapshot)
        {
            host.RequestSnapshot();
            Task.Delay(SnapshotWait).ContinueWith(_ => window.Invoke(() => window.Close()), TaskScheduler.Default);
            return true; // keep the window open for now
        }
        _closing = true;
        if (OperatingSystem.IsMacOS())
        {
            MacWindows.CloseAll();
        }
        else
        {
            DetachedWindows.CloseAll();
        }
        return false;
    }

    /// <summary>The window exists: messages may go to it, and its page may open windows of its own (DetachedWindows).</summary>
    private void OnCreated(PhotinoWindow window, PageChannel channel)
    {
        // The page's own windows say where they are as they move and resize, to open there again (after a restart
        // too), as the Windows host's do.
        DetachedWindows.Placed = (name, x, y, w, h) => channel.Post(new ToPage.WindowPlaced(name, x, y, w, h));
        if (OperatingSystem.IsMacOS())
        {
            MacWindows.Placed = DetachedWindows.Placed;
        }
        _created = true;
        window.Invoke(() =>
        {
            if (OperatingSystem.IsLinux() && GtkWindow.Find() is { } main)
            {
                GtkWindow.HideUntilLoaded(main);
                DetachedWindows.SetZoom(_zoom / (double)InterfaceSettings.DefaultZoom);
                GtkWindow.ClearBackground(main);
                DetachedWindows.Hook(main);
            }
            else if (OperatingSystem.IsMacOS())
            {
                // Rounded corners, maximize, and the page's own windows (Photino does none of them on macOS).
                MacWindows.Hook(action => window.Invoke(action), _zoom / (double)InterfaceSettings.DefaultZoom);
            }
        });
    }

    /// <summary>Tells the page the window's state after a change to one part of it (the others stay as they were).</summary>
    private void PostState(PageChannel channel, PhotinoWindow window, bool? minimized = null, bool? active = null)
    {
        _minimized = minimized ?? _minimized;
        _active = active ?? _active;
        channel.Post(new ToPage.WindowState(IsMaximized(window), _minimized, _active && !_minimized));
    }

    /// <summary>Photino on macOS fills the screen to maximize but never says it did (it asks for full screen): MacWindows knows.</summary>
    private static bool IsMaximized(PhotinoWindow window) => OperatingSystem.IsMacOS() ? MacWindows.IsMaximized(MacWindows.Main) : window.Maximized;

    /// <summary>What the page asks of the window: close, come to the front, and the title bar's buttons and edges.</summary>
    private void Follow(PhotinoPlatform platform, PhotinoWindow window, PageChannel channel, QuitGate quit)
    {
        platform.Attach(window);
        platform.CloseRequested += () =>
        {
            quit.Allow();
            window.Invoke(() => window.Close());
        };
        platform.QuitRequested += () => window.Invoke(() => window.Close()); // asks first (the closing handler)
        // Photino has no "focus": un-minimise, and briefly keep it on top so it shows above other windows. Wayland
        // may still leave the focus where it is.
        platform.Activate += () => window.Invoke(() =>
        {
            window.SetMinimized(false);
            window.SetTopMost(true);
            window.SetTopMost(false);
        });
        platform.WindowActionRequested += action => window.Invoke(() => Do(window, action, () => PostState(channel, window)));
    }

    /// <summary>One of the title bar's buttons or edges, on the window's thread.</summary>
    /// <param name="changed">Tells the page the window's state, where Photino doesn't (macOS's maximize).</param>
    private static void Do(PhotinoWindow window, FromPage.Window action, Action changed)
    {
        // A detached window's title bar (the page names the window): that window does it.
        if (action.Name is not null)
        {
            if (OperatingSystem.IsMacOS())
            {
                MacWindows.Act(action.Name, action.Action, action.Edge);
            }
            else
            {
                DetachedWindows.Act(action.Name, action.Action, action.Edge);
            }
            return;
        }
        if (OperatingSystem.IsMacOS())
        {
            DoOnMac(window, action, changed);
            return;
        }
        switch (action.Action)
        {
            case WindowActions.Minimize:
                window.SetMinimized(true);
                break;
            case WindowActions.Maximize:
                window.SetMaximized(!window.Maximized);
                break;
            case WindowActions.Close:
            case WindowActions.Quit:
                window.Close(); // asks first when something is running (the closing handler)
                break;
            case WindowActions.Drag:
                GtkWindow.BeginMove();
                break;
            case WindowActions.Resize when !window.Maximized && action.Edge is { } edge:
                GtkWindow.BeginResize(edge);
                break;
        }
    }

    /// <summary>The main window's buttons and edges on macOS: maximize, moves and sizes are MacWindows'.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("macos")]
    private static void DoOnMac(PhotinoWindow window, FromPage.Window action, Action changed)
    {
        var main = MacWindows.Main;
        void OnMain(Action run) => window.Invoke(run);
        switch (action.Action)
        {
            case WindowActions.Minimize:
                window.SetMinimized(true);
                break;
            case WindowActions.Maximize:
                MacWindows.ToggleMaximized(main);
                changed();
                break;
            case WindowActions.Close:
            case WindowActions.Quit:
                window.Close(); // asks first when something is running (the closing handler)
                break;
            case WindowActions.Drag:
                if (MacWindows.IsMaximized(main))
                {
                    MacWindows.Unmaximized(main);
                    changed();
                }
                MacWindowDrag.BeginMove(main, OnMain);
                break;
            case WindowActions.Resize when !MacWindows.IsMaximized(main) && action.Edge is { } edge:
                MacWindowDrag.BeginResize(main, edge, new Size(MinWidth, MinHeight), OnMain);
                break;
        }
    }
}
