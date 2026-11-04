using System.Drawing;
using System.Runtime.Versioning;
using Termilly.Desktop.Messaging;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// Moves and resizes a window from the page on macOS, as GtkWindow does on Linux. Cocoa has no "start a move with
/// the pointer that's down" a page's message could still catch (the mouse-down event is long gone when the message
/// comes), so the window follows the pointer itself until the left button is let go. The main window and the page's
/// own (MacWindows) alike: their frames are Cocoa's, from the bottom left, as the pointer's place is.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacWindowDrag
{
    /// <summary>How often the pointer is looked at while the button is down: about a screen refresh.</summary>
    private static readonly TimeSpan Step = TimeSpan.FromMilliseconds(8);
    /// <summary>pressedMouseButtons' bit for the left button.</summary>
    private const nuint LeftButton = 1;

    private static int _following;

    /// <summary>Moves the window with the pointer, until the button is let go; then <paramref name="done"/>.</summary>
    public static void BeginMove(IntPtr window, Action<Action> onMain, Action? done = null) =>
        Follow(window, onMain, done, (start, dx, dy) => start with { X = start.X + dx, Y = start.Y + dy });

    /// <summary>Resizes the window from one edge or corner, until the button is let go; never below <paramref name="min"/>.</summary>
    public static void BeginResize(IntPtr window, string edge, Size min, Action<Action> onMain, Action? done = null)
    {
        bool west = edge.Contains(ResizeEdges.West, StringComparison.Ordinal), east = edge.Contains(ResizeEdges.East, StringComparison.Ordinal);
        bool north = edge.StartsWith(ResizeEdges.North, StringComparison.Ordinal), south = edge.StartsWith(ResizeEdges.South, StringComparison.Ordinal);
        Follow(window, onMain, done, (start, dx, dy) =>
        {
            // Cocoa's y grows upwards: the top edge follows the pointer up, the bottom one moves the frame's origin.
            var width = Math.Max(min.Width, start.Width + (east ? dx : west ? -dx : 0));
            var height = Math.Max(min.Height, start.Height + (north ? dy : south ? -dy : 0));
            return new Rect(start.X + (west ? start.Width - width : 0), start.Y + (south ? start.Height - height : 0), width, height);
        });
    }

    /// <summary>
    /// Follows the pointer on a thread of its own while the left button is down, setting the window's frame (on the
    /// main thread) by how far the pointer has gone.
    /// </summary>
    private static void Follow(IntPtr window, Action<Action> onMain, Action? done, Func<Rect, double, double, Rect> place)
    {
        if (window == IntPtr.Zero || Interlocked.Exchange(ref _following, 1) == 1)
        {
            return;
        }
        var start = SendRect(window, Cocoa.Frame);
        var from = Pointer();
        new Thread(() =>
        {
            try
            {
                var last = start;
                while ((PressedButtons() & LeftButton) != 0)
                {
                    var now = Pointer();
                    var frame = place(start, Math.Round(now.X - from.X), Math.Round(now.Y - from.Y));
                    if (frame != last)
                    {
                        last = frame;
                        onMain(() => SetFrame(window, frame));
                    }
                    Thread.Sleep(Step);
                }
                done?.Invoke();
            }
            finally
            {
                Volatile.Write(ref _following, 0);
            }
        }) { IsBackground = true, Name = "window-drag" }.Start();
    }

    private static readonly IntPtr NSEvent = Class("NSEvent");

    /// <summary>Where the pointer is, in Cocoa's screen points (from the bottom left).</summary>
    private static Point2 Pointer() => objc_msgSend_point(NSEvent, Sel("mouseLocation"));

    private static nuint PressedButtons() => (nuint)Send(NSEvent, "pressedMouseButtons");

    [System.Runtime.InteropServices.StructLayout(System.Runtime.InteropServices.LayoutKind.Sequential)]
    private readonly record struct Point2(double X, double Y);

    // Two doubles come back in registers on arm64 and x86_64 alike, so plain objc_msgSend (not _stret) returns them.
    [System.Runtime.InteropServices.DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    private static extern Point2 objc_msgSend_point(IntPtr receiver, IntPtr selector);
}
