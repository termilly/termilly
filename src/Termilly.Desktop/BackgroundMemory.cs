using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace Termilly.Desktop;

/// <summary>
/// Lets a window's WebView2 give memory back while nobody can see it: minimized, or hidden in the tray. WebView2 then
/// drops caches and the window's drawing on the graphics card, and builds them again when the window shows. Measured
/// at about 85 to 110 MB of VRAM and 200 MB of GPU process memory for the main window, which a terminal left in the
/// background held for nothing.
/// </summary>
internal static class BackgroundMemory
{
    /// <summary>
    /// Follows <paramref name="window"/> from now on: low while it's minimized or hidden, normal while it shows. Called
    /// once its WebView2 is ready.
    /// </summary>
    public static void Follow(Window window, WebView2 web)
    {
        window.StateChanged += (_, _) => Apply(window, web);
        window.IsVisibleChanged += (_, _) => Apply(window, web);
        Apply(window, web);
    }

    /// <summary>Whether a window in this state is out of sight.</summary>
    internal static bool OutOfSight(bool visible, WindowState state) => !visible || state == WindowState.Minimized;

    private static void Apply(Window window, WebView2 web)
    {
        if (web.CoreWebView2 is not { } core)
        {
            return;
        }
        var level = OutOfSight(window.IsVisible, window.WindowState) ? CoreWebView2MemoryUsageTargetLevel.Low : CoreWebView2MemoryUsageTargetLevel.Normal;
        try
        {
            if (core.MemoryUsageTargetLevel != level)
            {
                core.MemoryUsageTargetLevel = level;
            }
        }
        catch (NotImplementedException)
        {
            // A WebView2 runtime older than this API (setup accepts some): the window keeps its memory, as before.
        }
    }
}
