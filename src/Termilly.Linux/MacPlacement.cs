using System.Runtime.Versioning;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// Where the main window was on macOS and whether it was maximized, kept in window.json (<see cref="SavedPlacement"/>)
/// and put back the next time Termilly opens. In the system's points, from the bottom left of the main screen as Cocoa
/// has them. The window always opens inside a screen: a place partly off one is moved and shrunk onto it, and a place on
/// no screen now (a display that's gone) is left out, so the window opens where it always did, fitted to its screen.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacPlacement
{
    private const string VisibleFrame = "visibleFrame";

    /// <summary>Puts the main window back where it was, maximized if it was; fitted to its screen either way.</summary>
    public static void Restore(IntPtr window)
    {
        var areas = UsableAreas();
        var saved = SavedPlacement.Read();
        var frame = saved is not null && WindowFit.Placed(new Rect(saved.X, saved.Y, saved.Width, saved.Height), areas) is { } back
            ? back
            : WindowFit.Placed(SendRect(window, Cocoa.Frame), areas); // the first start's size may not fit a small screen
        if (frame is { } fitted)
        {
            SetFrame(window, fitted);
        }
        if (saved?.Maximized == true)
        {
            MacWindows.ToggleMaximized(window);
        }
    }

    /// <summary>Remembers where the main window is now; called as it closes.</summary>
    public static void Save(IntPtr window, Rect? beforeMaximized)
    {
        if (window == IntPtr.Zero)
        {
            return;
        }
        var frame = beforeMaximized ?? SendRect(window, Cocoa.Frame);
        SavedPlacement.Write(new SavedPlacement.Saved(frame.X, frame.Y, frame.Width, frame.Height, beforeMaximized is not null));
    }

    /// <summary>Whether the middle of the frame's title bar is on one of the screens (their usable areas).</summary>
    internal static bool TitleBarShows(Rect frame) => WindowFit.TitleBarOn(frame, UsableAreas()) is not null;

    /// <summary>Each screen but its menu bar and Dock.</summary>
    private static List<Rect> UsableAreas()
    {
        var screens = Send(Class(Cocoa.Screen), Cocoa.Screens);
        var count = (nint)Send(screens, Cocoa.Count);
        var areas = new List<Rect>();
        for (nint i = 0; i < count; i++)
        {
            areas.Add(SendRect(Send(screens, Cocoa.ObjectAtIndex, i), VisibleFrame));
        }
        return areas;
    }
}
