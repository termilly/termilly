using System.Runtime.Versioning;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// Where the main window was on macOS and whether it was maximized, kept in window.json (<see cref="SavedPlacement"/>)
/// and put back the next time Termilly opens. In the system's points, from the bottom left of the main screen as Cocoa
/// has them. A place whose title bar is on no screen now (a display that's gone) is left out: the window opens where it
/// always did.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacPlacement
{
    /// <summary>How far down from a window's top its title bar is looked for on the screens, in points.</summary>
    private const double TitleBarDepth = 20;

    /// <summary>Puts the main window back where it was, maximized if it was.</summary>
    public static void Restore(IntPtr window)
    {
        if (SavedPlacement.Read() is not { } saved)
        {
            return;
        }
        var frame = new Rect(saved.X, saved.Y, saved.Width, saved.Height);
        if (!TitleBarShows(frame))
        {
            return;
        }
        SetFrame(window, frame);
        if (saved.Maximized)
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
    internal static bool TitleBarShows(Rect frame)
    {
        var screens = Send(Class(Cocoa.Screen), Cocoa.Screens);
        var count = (nint)Send(screens, Cocoa.Count);
        double x = frame.X + frame.Width / 2, y = frame.Y + frame.Height - TitleBarDepth;
        for (nint i = 0; i < count; i++)
        {
            var area = SendRect(Send(screens, Cocoa.ObjectAtIndex, i), "visibleFrame");
            if (x >= area.X && x <= area.X + area.Width && y >= area.Y && y <= area.Y + area.Height)
            {
                return true;
            }
        }
        return false;
    }
}
