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
/// <see cref="LinuxPlatform"/>) asks of the window.
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
    public void Run(LinuxPlatform platform, WindowTheme theme, PageChannel channel, PageHost host)
    {
        var window = _window = Create(theme, channel, host);
        var icon = Path.Combine(AppContext.BaseDirectory, "icons", "hicolor", "256x256", "apps", "termilly.png");
        if (File.Exists(icon))
        {
            window.SetIconFile(icon);
        }
        Follow(platform, window);
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

    private PhotinoWindow Create(WindowTheme theme, PageChannel channel, PageHost host)
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
            .SetMinSize(MinWidth, MinHeight)
            .SetDevToolsEnabled(Environment.GetEnvironmentVariable(DevToolsVariable) == "1")
            .SetContextMenuEnabled(false)
            .RegisterCustomSchemeHandler(AppScheme.Scheme, (object _, string _, string url, out string contentType) => AppScheme.Serve(url, theme.Palette, out contentType))
            .RegisterWindowCreatedHandler((_, _) => _created = true)
            .RegisterWebMessageReceivedHandler((_, message) =>
            {
                using var doc = JsonDocument.Parse(message);
                host.OnMessage(doc.RootElement);
            })
            .RegisterMaximizedHandler((_, _) => channel.Post(new ToPage.WindowState(true)))
            .RegisterRestoredHandler((_, _) => channel.Post(new ToPage.WindowState(window!.Maximized)))
            .RegisterWindowClosingHandler((_, _) =>
            {
                // As on Windows: with terminals to keep, the page first sends a last snapshot, then the window closes.
                if (host.WantsLastSnapshot)
                {
                    host.RequestSnapshot();
                    Task.Delay(SnapshotWait).ContinueWith(_ => window!.Invoke(() => window.Close()), TaskScheduler.Default);
                    return true; // keep the window open for now
                }
                _closing = true;
                return false;
            });
        return window;
    }

    /// <summary>What the page asks of the window: close, come to the front, and the title bar's buttons and edges.</summary>
    private static void Follow(LinuxPlatform platform, PhotinoWindow window)
    {
        platform.Attach(window);
        platform.CloseRequested += () => window.Invoke(() => window.Close());
        // Photino has no "focus": un-minimise, and briefly keep it on top so it shows above other windows. Wayland
        // may still leave the focus where it is.
        platform.Activate += () => window.Invoke(() =>
        {
            window.SetMinimized(false);
            window.SetTopMost(true);
            window.SetTopMost(false);
        });
        platform.WindowActionRequested += action => window.Invoke(() =>
        {
            switch (action.Action)
            {
                case WindowActions.Minimize:
                    window.SetMinimized(true);
                    break;
                case WindowActions.Maximize:
                    window.SetMaximized(!window.Maximized);
                    break;
                case WindowActions.Close:
                    window.Close();
                    break;
                case WindowActions.Drag:
                    GtkWindow.BeginMove();
                    break;
                case WindowActions.Resize when !window.Maximized && action.Edge is { } edge:
                    GtkWindow.BeginResize(edge);
                    break;
            }
        });
    }
}
