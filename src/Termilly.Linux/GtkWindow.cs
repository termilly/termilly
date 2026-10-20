using System.Runtime.InteropServices;
using Termilly.Desktop.Messaging;

namespace Termilly.Linux;

/// <summary>
/// Moves and resizes the window from the page, as WindowInterop does on Windows: the window has no title bar or
/// frame of its own (Photino's chromeless), so the page's title bar and edges ask the window manager to start a
/// move or resize with the pointer that's down. Works on Wayland and X11. Call on the window's (GTK) thread.
/// </summary>
internal static class GtkWindow
{
    private const string Gtk = "libgtk-3.so.0";
    private const string Gdk = "libgdk-3.so.0";
    private const string GLib = "libglib-2.0.so.0";
    /// <summary>The window's title (LinuxWindow sets it), which finds it among GTK's top-level windows.</summary>
    public const string Title = "Termilly";
    /// <summary>The program's id: Wayland's app id and X11's window class, matched to termilly.desktop.</summary>
    public const string ProgramId = "termilly";

    /// <summary>The page's edge names (as on Windows) and GTK's GdkWindowEdge for each.</summary>
    public static readonly IReadOnlyDictionary<string, int> Edges = new Dictionary<string, int>
    {
        [ResizeEdges.NorthWest] = GdkWindowEdge.NorthWest, [ResizeEdges.North] = GdkWindowEdge.North, [ResizeEdges.NorthEast] = GdkWindowEdge.NorthEast,
        [ResizeEdges.West] = GdkWindowEdge.West, [ResizeEdges.East] = GdkWindowEdge.East, [ResizeEdges.SouthWest] = GdkWindowEdge.SouthWest,
        [ResizeEdges.South] = GdkWindowEdge.South, [ResizeEdges.SouthEast] = GdkWindowEdge.SouthEast,
    };

    /// <summary>GTK's GdkWindowEdge values.</summary>
    private static class GdkWindowEdge
    {
        public const int NorthWest = 0, North = 1, NorthEast = 2, West = 3, East = 4, SouthWest = 5, South = 6, SouthEast = 7;
    }

    /// <summary>
    /// Names the program before GTK starts: Wayland's app id and X11's window class come from it, and desktops match
    /// them to termilly.desktop (StartupWMClass) for the dock icon and name.
    /// </summary>
    public static void SetProgramName(string id, string name)
    {
        g_set_prgname(id);
        g_set_application_name(name);
    }

    /// <summary>Starts moving the window with the pointer, until the button is let go.</summary>
    public static void BeginMove()
    {
        if (Find() is { } window && Pointer() is var (x, y))
        {
            gtk_window_begin_move_drag(window, 1, x, y, gtk_get_current_event_time());
        }
    }

    /// <summary>Starts resizing the window from one edge or corner, until the button is let go.</summary>
    public static void BeginResize(string edge)
    {
        if (Edges.TryGetValue(edge, out var gdkEdge) && Find() is { } window && Pointer() is var (x, y))
        {
            gtk_window_begin_resize_drag(window, gdkEdge, 1, x, y, gtk_get_current_event_time());
        }
    }

    /// <summary>Termilly's window: its one visible top-level window titled Termilly (Photino doesn't give out its handle on Linux).</summary>
    private static IntPtr? Find()
    {
        var list = gtk_window_list_toplevels();
        try
        {
            for (var node = list; node != IntPtr.Zero; node = Marshal.ReadIntPtr(node, IntPtr.Size))
            {
                var window = Marshal.ReadIntPtr(node);
                if (gtk_widget_get_visible(window) != 0 && Marshal.PtrToStringUTF8(gtk_window_get_title(window)) == Title)
                {
                    return window;
                }
            }
            return null;
        }
        finally
        {
            g_list_free(list);
        }
    }

    /// <summary>Where the pointer is on screen (the window manager wants it; Wayland ignores it).</summary>
    private static (int X, int Y)? Pointer()
    {
        var seat = gdk_display_get_default_seat(gdk_display_get_default());
        var pointer = seat == IntPtr.Zero ? IntPtr.Zero : gdk_seat_get_pointer(seat);
        if (pointer == IntPtr.Zero)
        {
            return null;
        }
        gdk_device_get_position(pointer, out _, out var x, out var y);
        return (x, y);
    }

    [DllImport(Gtk)] private static extern IntPtr gtk_window_list_toplevels();
    [DllImport(Gtk)] private static extern IntPtr gtk_window_get_title(IntPtr window);
    [DllImport(Gtk)] private static extern int gtk_widget_get_visible(IntPtr widget);
    [DllImport(Gtk)] private static extern uint gtk_get_current_event_time();
    [DllImport(Gtk)] private static extern void gtk_window_begin_move_drag(IntPtr window, int button, int rootX, int rootY, uint timestamp);
    [DllImport(Gtk)] private static extern void gtk_window_begin_resize_drag(IntPtr window, int edge, int button, int rootX, int rootY, uint timestamp);
    [DllImport(Gdk)] private static extern IntPtr gdk_display_get_default();
    [DllImport(Gdk)] private static extern IntPtr gdk_display_get_default_seat(IntPtr display);
    [DllImport(Gdk)] private static extern IntPtr gdk_seat_get_pointer(IntPtr seat);
    [DllImport(Gdk)] private static extern void gdk_device_get_position(IntPtr device, out IntPtr screen, out int x, out int y);
    [DllImport(GLib)] private static extern void g_list_free(IntPtr list);
    [DllImport(GLib)] private static extern void g_set_prgname([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(GLib)] private static extern void g_set_application_name([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
}
