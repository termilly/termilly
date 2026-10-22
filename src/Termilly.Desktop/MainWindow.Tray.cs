using System.Windows;
using System.Windows.Threading;

namespace Termilly.Desktop;

/// <summary>
/// The window's side of quitting and the tray: Close and Minimize may hide it in the tray (TrayIcon.cs), quitting asks
/// first when something runs (QuitGate), and coming back from the tray brings the page back on screen.
/// </summary>
public partial class MainWindow
{
    /// <summary>The tray icon: there only while the window is hidden in the tray (Settings › Workspaces › Minimize and Close).</summary>
    private TrayIcon CreateTray()
    {
        var tray = new TrayIcon(BringToFront, RequestQuit);
        IsVisibleChanged += (_, _) =>
        {
            if (IsVisible)
            {
                tray.Hide();
            }
        };
        return tray;
    }

    /// <summary>Hides the window in the tray: Termilly keeps running, and the tray icon brings it back.</summary>
    private void HideToTray()
    {
        Hide();
        _tray?.Show();
    }

    /// <summary>The user wants to quit: asks first when something is running (QuitGate), then closes.</summary>
    internal void RequestQuit() => _quit.Ask(() => Dispatcher.BeginInvoke(QuitNow));

    /// <summary>Quits without asking: an update restarting Termilly, the page's last snapshot in, or the user said so.</summary>
    internal void QuitNow()
    {
        _quit.Allow();
        CloseOnce();
    }

    /// <summary>Windows is signing out or shutting down: Termilly closes without asking or hiding.</summary>
    internal void AllowQuit() => _quit.Allow();

    /// <summary>Shows the window on top, restoring it from the taskbar or the tray if needed.</summary>
    internal void BringToFront()
    {
        var fromTray = !IsVisible;
        Show();
        WindowInterop.Restore(this);
        if (fromTray)
        {
            RepaintPage();
        }
        Activate();
        Web.Focus();
    }

    /// <summary>
    /// WebView2 shown again after the window was hidden (in the tray) keeps a blank page until its size changes: so it
    /// changes, by a pixel and back.
    /// </summary>
    private void RepaintPage()
    {
        Web.Width = Math.Max(0, Stage.ActualWidth - 1);
        Dispatcher.BeginInvoke(DispatcherPriority.Background, FitPageToWindow);
    }
}
