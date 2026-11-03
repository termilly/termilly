using System.ComponentModel;
using System.Windows;
using System.Windows.Media.Imaging;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Termilly.Desktop;

/// <summary>
/// A terminal, the Notepad or the Snippets window in a window of its own on Windows (js/windows.js). The page opens it
/// with window.open and moves the element into it; this window only shows that page, in Windows' own title bar
/// coloured to the theme. The main page keeps everything that happens in it, so closing this window asks the page
/// (detached.html's termillyClose), which takes the element back and then closes it.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "WPF never disposes a window: OnClosed disposes its browser.")]
internal sealed class DetachedWindow : Window
{
    /// <summary>The page this window shows, the only one window.open may open as a window (MainWindow).</summary>
    public const string PageName = "detached.html";
    /// <summary>What detached.html runs when the user closes the window (it closes it once the page is ready).</summary>
    private const string AskToClose = "window.termillyClose ? termillyClose() : window.close()";
    private const double MinSize = 240;

    private readonly WebView2 _web = new();
    /// <summary>Set once the page has closed it (window.close()): this close goes through.</summary>
    private bool _closedByPage;

    /// <summary>window.open's name for it (its target), which the page uses to bring it to the front.</summary>
    public string PageWindowName { get; }

    public DetachedWindow(string name, ThemeWindowColors colors, CoreWebView2WindowFeatures features)
    {
        PageWindowName = name;
        Title = Product.Name;
        MinWidth = MinHeight = MinSize;
        Icon = BitmapFrame.Create(new Uri(AppPaths.IconFile));
        Background = new System.Windows.Media.SolidColorBrush(
            (System.Windows.Media.Color)System.Windows.Media.ColorConverter.ConvertFromString(colors.Background));
        _web.DefaultBackgroundColor = System.Drawing.ColorTranslator.FromHtml(colors.Background);
        Content = _web;
        // window.open's size is the page's (the client area); Windows' frame and title bar come on top of it.
        SizeToContent = SizeToContent.Manual;
        if (features.HasSize)
        {
            _web.Width = features.Width;
            _web.Height = features.Height;
            SizeToContent = SizeToContent.WidthAndHeight;
        }
        if (features.HasPosition)
        {
            WindowStartupLocation = WindowStartupLocation.Manual;
            Left = features.Left;
            Top = features.Top;
        }
        SourceInitialized += (_, _) => WindowInterop.ColorTitleBar(this, colors);
        // Sized to the page once; from then on the page follows the window.
        ContentRendered += (_, _) =>
        {
            SizeToContent = SizeToContent.Manual;
            _web.Width = double.NaN;
            _web.Height = double.NaN;
        };
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

    /// <summary>The theme changed: the title bar follows.</summary>
    public void Recolor(ThemeWindowColors colors) => WindowInterop.ColorTitleBar(this, colors);

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
        // The title bar's X, Alt+F4: the page takes back what it shows first (it may ask about changes not saved),
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
