using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// The window's side of the page's own windows (a terminal, the Notepad or the Snippets window detached, js/windows.js):
/// it opens them (DetachedWindow), hands their title bars' actions to them, and tells the page where a dragged one is
/// over this window.
/// </summary>
public partial class MainWindow
{
    /// <summary>The page's own windows (a terminal, the Notepad or the Snippets window detached), while they're open.</summary>
    private readonly List<DetachedWindow> _detached = [];

    /// <summary>The page's window by its name: a detached one, else (no name, or gone) this one.</summary>
    internal System.Windows.Window WindowNamed(string? pageWindowName) =>
        _detached.Find(w => w.PageWindowName == pageWindowName) is { } detached ? detached : this;

    /// <summary>
    /// window.open of one of the page's own windows (named so, js/windows.js): a window of its own (DetachedWindow), still
    /// the page's (window.opener), which builds its empty page and moves into it what it shows. Anything else is left
    /// to WebView2, as before.
    /// </summary>
    private async void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        if (!e.Name.StartsWith(DetachedWindowNames.NamePrefix, StringComparison.Ordinal) || _closing)
        {
            return;
        }
        using var deferral = e.GetDeferral();
        var window = new DetachedWindow(e.Name, _theme.Palette, e.WindowFeatures);
        _detached.Add(window);
        window.Closed += (_, _) => _detached.Remove(window);
        window.Moved += OnDetachedMoved;
        window.Placed += (w, r) => _channel.Post(new ToPage.WindowPlaced(w.PageWindowName, r.X, r.Y, r.Width, r.Height));
        e.NewWindow = await window.StartAsync(Web.CoreWebView2.Environment, HostName);
        window.Zoom(Zoom);
        e.Handled = true;
    }

    /// <summary>A dragged terminal's picture following the pointer (DragPictureWindow), while there is one.</summary>
    private DragPictureWindow? _dragPicture;

    /// <summary>A dragged terminal's picture to follow the pointer from now on, or none (no image): the one shown goes.</summary>
    internal void ShowDragPicture(FromPage.DragPicture picture)
    {
        _dragPicture?.Close();
        _dragPicture = null;
        if (picture.Image is { Length: > 0 } image && picture.Width > 0 && picture.Height > 0 && !_closing)
        {
            _dragPicture = new DragPictureWindow(picture, image, Zoom);
            _dragPicture.Show();
        }
    }

    /// <summary>A picture of the page as it is now, a JPEG in base64 (for a terminal dragged out, js/panes.js).</summary>
    internal async Task<string?> CapturePageAsync()
    {
        if (Web.CoreWebView2 is not { } core)
        {
            return null;
        }
        using var picture = new MemoryStream();
        await core.CapturePreviewAsync(CoreWebView2CapturePreviewImageFormat.Jpeg, picture);
        return Convert.ToBase64String(picture.ToArray());
    }

    /// <summary>
    /// A detached window moved by its title bar: the page hears where the pointer is over its page (none when it isn't,
    /// or this window is hidden or minimized), and when it's let go, so a terminal can be dropped back into its layout.
    /// </summary>
    private void OnDetachedMoved(DetachedWindow window, bool dropped)
    {
        double? x = null, y = null;
        var cursor = WindowInterop.CursorPosition();
        if (IsVisible && WindowState != WindowState.Minimized && !double.IsNaN(cursor.X))
        {
            var at = Web.PointFromScreen(cursor);
            if (at.X >= 0 && at.Y >= 0 && at.X < Web.ActualWidth && at.Y < Web.ActualHeight)
            {
                (x, y) = (at.X, at.Y);
            }
        }
        _channel.Post(new ToPage.WindowDragged(window.PageWindowName, x, y, dropped));
    }
}
