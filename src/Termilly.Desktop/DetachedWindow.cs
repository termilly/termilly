using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// A terminal, the Notepad or the Snippets window in a window of its own on Windows (js/windows.js). The page opens it
/// with window.open and moves the element into it. Like the main window it has no title bar of its own: the element's
/// header is it, with the window's buttons, and the page asks this window to move, size, minimize or maximize
/// (<see cref="Act"/>). The main page keeps everything that happens in it, so closing this window (Alt+F4) asks the
/// page (the termillyClose it gives the window), which takes the element back and then closes it.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "WPF never disposes a window: OnClosed disposes its browser.")]
internal sealed class DetachedWindow : Window
{
    /// <summary>What the window runs when the user closes it: the page closes it once it has taken back what it shows.</summary>
    private const string AskToClose = "window.termillyClose ? termillyClose() : window.close()";
    private const double MinSize = 240;
    /// <summary>The frame around the page, as the main window's (MainWindow.xaml).</summary>
    private const double FrameWidth = 1;
    /// <summary>A terminal's title bar, the page's header (app.css .pane-header), all a window dragged to land shows.</summary>
    private const double TitleBarHeight = 30;

    private readonly WebView2 _web = new();
    private readonly Border _frame = new() { BorderThickness = new Thickness(FrameWidth) };
    /// <summary>Set once the page has closed it (window.close()): this close goes through.</summary>
    private bool _closedByPage;
    /// <summary>While a move its title bar started is under way (a resize isn't one): its steps are reported.</summary>
    private bool _moving;

    private const int WM_MOVING = 0x0216;
    private const int WM_EXITSIZEMOVE = 0x0232;

    /// <summary>
    /// Moved by its title bar: each step of the move (false), and once more when it's let go (true). The main window
    /// tells the page where the pointer is over it, so a terminal can be dropped back into its layout.
    /// </summary>
    public event Action<DetachedWindow, bool>? Moved;

    /// <summary>window.open's name for it (its target), which the page uses to act on it.</summary>
    public string PageWindowName { get; }

    public DetachedWindow(string name, ThemeWindowColors colors, CoreWebView2WindowFeatures features)
    {
        PageWindowName = name;
        Title = Product.Name;
        MinWidth = MinHeight = MinSize;
        Icon = BitmapFrame.Create(new Uri(AppPaths.IconFile));
        // No caption or control box of its own, as the main window: the page's header is its title bar.
        WindowStyle = WindowStyle.None;
        ResizeMode = ResizeMode.CanResize;
        WindowChrome.SetWindowChrome(this, new WindowChrome
        {
            CaptionHeight = 0, ResizeBorderThickness = new Thickness(0), GlassFrameThickness = new Thickness(0, 0, 0, 1),
            CornerRadius = new CornerRadius(0), UseAeroCaptionButtons = false,
        });
        WindowInterop.UseCustomChrome(this, sharpIcons: false);
        SourceInitialized += (_, _) => HwndSource.FromHwnd(new WindowInteropHelper(this).Handle).AddHook(OnMessage);
        _frame.Child = _web;
        Content = _frame;
        Recolor(colors);
        // window.open's size is the page's; the frame goes around it.
        if (features.HasSize)
        {
            Width = features.Width + (2 * FrameWidth);
            Height = features.Height + (2 * FrameWidth);
        }
        // window.open's place is the page's too (where it says it is, window.screenX), inside the frame.
        if (features.HasPosition)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = features.Left - FrameWidth;
            Top = features.Top - FrameWidth;
        }
    }

    /// <summary>
    /// Shows the window and readies its browser for the page window.open opens in it, served from the same folder
    /// under the same host name as the main page (each browser has its own mapping).
    /// </summary>
    public async Task<CoreWebView2> StartAsync(CoreWebView2Environment environment, string hostName)
    {
        Show();
        await _web.EnsureCoreWebView2Async(environment);
        var core = _web.CoreWebView2;
        core.SetVirtualHostNameToFolderMapping(hostName, AppPaths.WebRoot, CoreWebView2HostResourceAccessKind.Deny);
        core.Settings.AreBrowserAcceleratorKeysEnabled = false; // F5, Ctrl+F etc. reach the terminal
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
        core.DocumentTitleChanged += (_, _) => Title = core.DocumentTitle is { Length: > 0 } title ? title : Product.Name;
        core.WindowCloseRequested += (_, _) =>
        {
            _closedByPage = true;
            Close();
        };
        return core;
    }

    /// <summary>The theme changed: the background and frame follow, as the main window's.</summary>
    public void Recolor(ThemeWindowColors colors)
    {
        Background = Brush(colors.Background);
        _frame.BorderBrush = Brush(colors.Frame);
        _web.DefaultBackgroundColor = System.Drawing.ColorTranslator.FromHtml(colors.Background);
    }

    private static SolidColorBrush Brush(string hex) => (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;

    /// <summary>What its title bar (the page's header) asks: minimize, maximize or restore, move, or resize from an edge.</summary>
    public void Act(FromPage.Window action)
    {
        switch (action.Action)
        {
            case WindowActions.Minimize:
                WindowState = WindowState.Minimized;
                break;
            case WindowActions.Maximize:
                WindowState = WindowState == WindowState.Maximized ? WindowState.Normal : WindowState.Maximized;
                break;
            case WindowActions.Drag:
                // Windows moves it until the button is let go; its steps come to OnMessage. Started once this page
                // message is handled: WebView2 holds the page's next messages until then, and the page answers the
                // steps (shrinking the window over a place it would land) while it moves.
                Dispatcher.BeginInvoke(() =>
                {
                    _moving = true;
                    WindowInterop.BeginNonClientDrag(this, WindowInterop.HTCAPTION);
                    _moving = false;
                });
                break;
            case WindowActions.Fade:
            case WindowActions.Solid:
                // Over a place it would land: only its title bar shows (the page's header and the frame above it).
                WindowInterop.ShowOnlyTop(this, action.Action == WindowActions.Fade ? TitleBarHeight + FrameWidth : null);
                break;
            case WindowActions.Resize when WindowState == WindowState.Normal && action.Edge is { } edge
                && WindowInterop.EdgeHitTests.TryGetValue(edge, out var hitTest):
                WindowInterop.BeginNonClientDrag(this, hitTest);
                break;
            case WindowActions.Focus:
                BringToFront();
                break;
        }
    }

    /// <summary>The steps of a move its title bar started, and its end.</summary>
    private IntPtr OnMessage(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (_moving && msg == WM_MOVING)
        {
            Moved?.Invoke(this, false);
        }
        else if (_moving && msg == WM_EXITSIZEMOVE)
        {
            _moving = false;
            Moved?.Invoke(this, true);
        }
        return IntPtr.Zero;
    }

    /// <summary>To the front, out of the taskbar if it was minimized.</summary>
    public void BringToFront()
    {
        if (WindowState == WindowState.Minimized)
        {
            WindowState = WindowState.Normal;
        }
        Activate();
        _web.Focus();
    }

    /// <summary>Closed by the main window going away: no asking the page, which is going too.</summary>
    public void CloseNow()
    {
        _closedByPage = true;
        Close();
    }

    protected override void OnClosing(CancelEventArgs e)
    {
        // Alt+F4, the taskbar's Close: the page takes back what it shows first (it may ask about changes not saved),
        // then closes the window itself.
        if (!_closedByPage && _web.CoreWebView2 is { } core)
        {
            e.Cancel = true;
            _ = core.ExecuteScriptAsync(AskToClose);
            return;
        }
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        _web.Dispose();
        base.OnClosed(e);
    }
}
