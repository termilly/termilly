using System.Drawing;
using System.Runtime.Versioning;
using Termilly.Desktop.Messaging;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// Moves and resizes a window from the page on macOS, as GtkWindow does on Linux. A move is macOS's own
/// (performWindowDragWithEvent:), so the window can go onto another display: one moved by setting its frame stays on
/// the display it was on ("Displays have separate Spaces"), cut off at its edge. The mouse-down is long gone by the
/// time the page's message comes, so the drag starts from the mouse event the app is handling, or one made at the
/// pointer. Should the window not follow that, and for resizes, it follows the pointer itself until the left button
/// is let go. The main window and the page's own (MacWindows) alike: their frames are Cocoa's, from the bottom left,
/// as the pointer's place is.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacWindowDrag
{
    /// <summary>How often the pointer is looked at while the button is down: about a screen refresh.</summary>
    private static readonly TimeSpan Step = TimeSpan.FromMilliseconds(8);
    /// <summary>pressedMouseButtons' bit for the left button.</summary>
    private const nuint LeftButton = 1;

    private static int _following;

    /// <summary>
    /// How far the pointer must have gone (in points), and how long ago the move began, before a window macOS hasn't
    /// moved is taken to be one it won't: Follow moves it then. macOS moves its windows within a frame or two.
    /// </summary>
    private const double NativeSlop = 24;
    private static readonly TimeSpan NativeWait = TimeSpan.FromMilliseconds(250);
    /// <summary>How long after the button is let go macOS is given to put the window where it ends, before done.</summary>
    private static readonly TimeSpan NativeSettle = TimeSpan.FromMilliseconds(100);
    /// <summary>NSEventType's left mouse down and dragged.</summary>
    private const nuint LeftMouseDown = 1, LeftMouseDragged = 6;
    /// <summary>Whether macOS moves the window being moved: not known yet, no (Follow does), yes.</summary>
    private const int NativeUnknown = 0, NativeNo = 1, NativeYes = 2;

    /// <summary>
    /// Moves the window with the pointer, macOS's way, until the button is let go; then <paramref name="done"/>.
    /// Should macOS not move it, it follows the pointer itself.
    /// </summary>
    public static void BeginMove(IntPtr window, Action<Action> onMain, Action? done = null)
    {
        var native = NativeUnknown;
        var began = System.Diagnostics.Stopwatch.StartNew();
        Follow(window, onMain, () =>
        {
            if (Volatile.Read(ref native) != NativeNo)
            {
                Thread.Sleep(NativeSettle);
            }
            done?.Invoke();
        }, (frame, dx, dy) => frame with { X = frame.X + dx, Y = frame.Y + dy }, (start, from) =>
        {
            onMain(() => NativeDrag(window, from));
            return (dx, dy) =>
            {
                if (Volatile.Read(ref native) == NativeUnknown && began.Elapsed > NativeWait && Math.Abs(dx) + Math.Abs(dy) > NativeSlop)
                {
                    onMain(() => Volatile.Write(ref native, SendRect(window, Cocoa.Frame) == start ? NativeNo : NativeYes));
                }
                return Volatile.Read(ref native) == NativeNo;
            };
        });
    }

    /// <summary>
    /// Starts macOS's own move of the window, from the left mouse event being handled in it, or one made at the pointer.
    /// </summary>
    private static void NativeDrag(IntPtr window, Point2 pointer)
    {
        var current = Send(Send(Class(Cocoa.Application), Cocoa.SharedApplication), "currentEvent");
        var type = current == IntPtr.Zero ? 0 : (nuint)Send(current, "type");
        if (type is not (LeftMouseDown or LeftMouseDragged) || Send(current, WindowOf) != window)
        {
            var frame = SendRect(window, Cocoa.Frame);
            var uptime = SendDouble(Send(Class("NSProcessInfo"), "processInfo"), "systemUptime");
            current = msgSend_mouseEvent(NSEvent, Sel(MouseEventWith), LeftMouseDown, new Point2(pointer.X - frame.X, pointer.Y - frame.Y),
                0, uptime, Send(window, "windowNumber"), IntPtr.Zero, 0, 1, 1f);
        }
        Send(window, "performWindowDragWithEvent:", current);
    }

    private const string MouseEventWith = "mouseEventWithType:location:modifierFlags:timestamp:windowNumber:context:eventNumber:clickCount:pressure:";

    /// <summary>How far down from a window's top a click is on its title bar (the page's header), in page pixels.</summary>
    private const double TitleBarHeight = 42;
    private const string AcceptsFirstMouse = "acceptsFirstMouse:";
    /// <summary>An event's or a view's window.</summary>
    private const string WindowOf = "window";

    /// <summary>acceptsFirstMouse:'s shape: answers a BOOL.</summary>
    [System.Runtime.InteropServices.UnmanagedFunctionPointer(System.Runtime.InteropServices.CallingConvention.Cdecl)]
    private delegate byte FirstMouse(IntPtr self, IntPtr selector, IntPtr mouseDown);

    // Kept alive as long as the app runs: WebKit calls them.
    private static FirstMouse? _firstMouse, _webKits;
    private static Func<double> _zoom = () => 1;

    /// <summary>
    /// Lets a click on a window's title bar while another app is in front reach the page, as a native title bar takes
    /// it: else macOS spends it on bringing Termilly to the front, and the window can only be moved by a second one.
    /// Clicks anywhere else stay WebKit's (a first click only brings the window forward). All the app's web views
    /// (WKWebView, Photino's and the page's own windows'); <paramref name="zoom"/> is the page's zoom now.
    /// </summary>
    public static void TakeFirstClickOnTitleBar(Func<double> zoom)
    {
        var webView = Class("WKWebView");
        if (webView == IntPtr.Zero || _firstMouse is not null)
        {
            return;
        }
        _zoom = zoom;
        var webKits = class_getMethodImplementation(webView, Sel(AcceptsFirstMouse));
        _webKits = webKits == IntPtr.Zero ? null : System.Runtime.InteropServices.Marshal.GetDelegateForFunctionPointer<FirstMouse>(webKits);
        _firstMouse = (self, selector, mouseDown) =>
            OnTitleBar(self, mouseDown) ? (byte)1 : _webKits?.Invoke(self, selector, mouseDown) ?? 0;
        AddMethod(webView, AcceptsFirstMouse, _firstMouse, "B@:@");
    }

    /// <summary>Whether a mouse-down is on the title bar of the view's window (Cocoa's y grows upwards).</summary>
    private static bool OnTitleBar(IntPtr view, IntPtr mouseDown)
    {
        if (mouseDown == IntPtr.Zero)
        {
            return false;
        }
        var at = objc_msgSend_point(mouseDown, Sel("locationInWindow"));
        var height = SendRect(Send(Send(view, WindowOf), Cocoa.ContentView), Cocoa.Frame).Height;
        return at.Y >= height - TitleBarHeight * _zoom();
    }

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
    /// <param name="begin">
    /// Called once the move is this one's (with the frame and pointer it starts from): answers whether the frame is set
    /// here, by how far the pointer has gone (not while macOS moves it).
    /// </param>
    private static void Follow(IntPtr window, Action<Action> onMain, Action? done, Func<Rect, double, double, Rect> place,
        Func<Rect, Point2, Func<double, double, bool>>? begin = null)
    {
        if (window == IntPtr.Zero || Interlocked.Exchange(ref _following, 1) == 1)
        {
            return;
        }
        Send(window, "retain"); // kept until the move is over, should the window close meanwhile
        var start = SendRect(window, Cocoa.Frame);
        var from = Pointer();
        var ours = begin?.Invoke(start, from);
        new Thread(() =>
        {
            try
            {
                var last = start;
                while ((PressedButtons() & LeftButton) != 0)
                {
                    var now = Pointer();
                    double dx = Math.Round(now.X - from.X), dy = Math.Round(now.Y - from.Y);
                    var frame = place(start, dx, dy);
                    if ((ours?.Invoke(dx, dy) ?? true) && frame != last)
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
                onMain(() => Send(window, "release"));
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

    [System.Runtime.InteropServices.DllImport("/usr/lib/libobjc.A.dylib")]
    private static extern IntPtr class_getMethodImplementation(IntPtr cls, IntPtr selector);

    [System.Runtime.InteropServices.DllImport("/usr/lib/libobjc.A.dylib", EntryPoint = "objc_msgSend")]
    private static extern IntPtr msgSend_mouseEvent(IntPtr receiver, IntPtr selector, nuint type, Point2 location, nuint flags,
        double timestamp, IntPtr windowNumber, IntPtr context, nint eventNumber, nint clickCount, float pressure);
}
