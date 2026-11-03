using System.Drawing;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Photino.NET;
using Termilly.Desktop.Messaging;

namespace Termilly.Linux;

/// <summary>
/// Moves and resizes the window from the page on macOS, as GtkWindow does on Linux. Cocoa has no "start a move with
/// the pointer that's down" a page's message could still catch (the mouse-down event is long gone when the message
/// comes), so the window follows the pointer itself until the left button is let go.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacWindowDrag
{
    /// <summary>How often the pointer is looked at while the button is down: about a screen refresh.</summary>
    private static readonly TimeSpan Step = TimeSpan.FromMilliseconds(8);
    /// <summary>pressedMouseButtons' bit for the left button.</summary>
    private const nuint LeftButton = 1;
    private const string LibObjC = "/usr/lib/libobjc.A.dylib";

    private static int _following;

    /// <summary>Moves the window with the pointer, until the button is let go.</summary>
    public static void BeginMove(PhotinoWindow window) => Follow(window, (start, _, dx, dy) => (new Point(start.X + dx, start.Y + dy), null));

    /// <summary>Resizes the window from one edge or corner, until the button is let go; never below its minimum size.</summary>
    public static void BeginResize(PhotinoWindow window, string edge, Size min)
    {
        bool west = edge.Contains(ResizeEdges.West, StringComparison.Ordinal), east = edge.Contains(ResizeEdges.East, StringComparison.Ordinal);
        bool north = edge.StartsWith(ResizeEdges.North, StringComparison.Ordinal), south = edge.StartsWith(ResizeEdges.South, StringComparison.Ordinal);
        Follow(window, (start, size, dx, dy) =>
        {
            var width = Math.Max(min.Width, size.Width + (east ? dx : west ? -dx : 0));
            var height = Math.Max(min.Height, size.Height + (south ? dy : north ? -dy : 0));
            // The west and north edges move the window's corner by however much the size really changed.
            var at = new Point(start.X + (west ? size.Width - width : 0), start.Y + (north ? size.Height - height : 0));
            return (at, new Size(width, height));
        });
    }

    /// <summary>
    /// Follows the pointer on a thread of its own while the left button is down, placing the window (on its own
    /// thread) by how far the pointer has gone. Cocoa's y grows upwards; the window's grows downwards.
    /// </summary>
    private static void Follow(PhotinoWindow window, Func<Point, Size, int, int, (Point At, Size? Size)> place)
    {
        if (Interlocked.Exchange(ref _following, 1) == 1)
        {
            return;
        }
        Point start = window.Location;
        Size size = window.Size;
        var from = Pointer();
        new Thread(() =>
        {
            try
            {
                while ((PressedButtons() & LeftButton) != 0)
                {
                    var now = Pointer();
                    var (at, newSize) = place(start, size, (int)Math.Round(now.X - from.X), (int)Math.Round(from.Y - now.Y));
                    window.Invoke(() =>
                    {
                        if (newSize is { } resized)
                        {
                            window.SetSize(resized);
                        }
                        window.SetLocation(at);
                    });
                    Thread.Sleep(Step);
                }
            }
            finally
            {
                Volatile.Write(ref _following, 0);
            }
        }) { IsBackground = true, Name = "window-drag" }.Start();
    }

    private static readonly IntPtr NSEvent = objc_getClass("NSEvent");
    private static readonly IntPtr MouseLocation = sel_registerName("mouseLocation");
    private static readonly IntPtr PressedMouseButtons = sel_registerName("pressedMouseButtons");

    /// <summary>Where the pointer is, in Cocoa's screen points (from the bottom left).</summary>
    private static CGPoint Pointer() => objc_msgSend_point(NSEvent, MouseLocation);

    private static nuint PressedButtons() => objc_msgSend_buttons(NSEvent, PressedMouseButtons);

    [StructLayout(LayoutKind.Sequential)]
    private readonly record struct CGPoint(double X, double Y);

    [DllImport(LibObjC)] private static extern IntPtr objc_getClass([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(LibObjC)] private static extern IntPtr sel_registerName([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    // Two doubles come back in registers on arm64 and x86_64 alike, so plain objc_msgSend (not _stret) returns them.
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern CGPoint objc_msgSend_point(IntPtr receiver, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern nuint objc_msgSend_buttons(IntPtr receiver, IntPtr selector);
}
