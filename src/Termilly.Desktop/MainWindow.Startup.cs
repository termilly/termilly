using System.ComponentModel;
using System.IO;
using System.Windows.Threading;
using Termilly.Shared;

namespace Termilly.Desktop;

/// <summary>
/// The window's start: the start-up screen telling an update window it's up (#63), and the page shown anyway if it never
/// reports in.
/// </summary>
public partial class MainWindow
{
    /// <summary>
    /// Shows the page after RevealTimeout even if it never reports in, so the window is never stuck on the start-up screen.
    /// Returns the timer, which RevealPage stops.
    /// </summary>
    private DispatcherTimer StartRevealFallback()
    {
        var timer = new DispatcherTimer { Interval = RevealTimeout };
        timer.Tick += (_, _) =>
        {
            StartupLog.Mark($"page not ready after {RevealTimeout.TotalSeconds:0} s: shown anyway");
            RevealPage();
        };
        timer.Start();
        return timer;
    }

    /// <summary>The start-up screen is painted: an update window waiting for it (Setup's UpdateWindow) may close now.</summary>
    private void OnStartupScreenPainted(object? sender, EventArgs e)
    {
        ContentRendered -= OnStartupScreenPainted;
        StartupLog.Mark("window shown (start-up screen)");
        try
        {
            if (UpdateSignals.SignalStarted(AppContext.BaseDirectory))
            {
                StartupLog.Mark("update startup screen paint signalled");
            }
        }
        catch (Exception error) when (error is Win32Exception or UnauthorizedAccessException or IOException)
        {
            StartupLog.Mark($"update startup screen signal unavailable: {error.Message}");
        }
    }
}
