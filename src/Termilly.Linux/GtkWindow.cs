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
    private const string GObjectName = "libgobject-2.0.so.0";
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

    /// <summary>Starts moving the window (Termilly's, or <paramref name="other"/>) with the pointer, until the button is let go.</summary>
    public static void BeginMove(IntPtr? other = null)
    {
        if ((other ?? Find()) is { } window && Pointer() is var (x, y))
        {
            gtk_window_begin_move_drag(window, 1, x, y, gtk_get_current_event_time());
        }
    }

    /// <summary>Starts resizing the window (Termilly's, or <paramref name="other"/>) from one edge or corner, until the button is let go.</summary>
    public static void BeginResize(string edge, IntPtr? other = null)
    {
        if (Edges.TryGetValue(edge, out var gdkEdge) && (other ?? Find()) is { } window && Pointer() is var (x, y))
        {
            gtk_window_begin_resize_drag(window, gdkEdge, 1, x, y, gtk_get_current_event_time());
        }
    }

    /// <summary>
    /// Termilly's window: its one visible top-level window titled Termilly that isn't a detached one (Photino doesn't
    /// give out its handle on Linux).
    /// </summary>
    public static IntPtr? Find()
    {
        var list = gtk_window_list_toplevels();
        try
        {
            for (var node = list; node != IntPtr.Zero; node = Marshal.ReadIntPtr(node, IntPtr.Size))
            {
                var window = Marshal.ReadIntPtr(node);
                if (gtk_widget_get_visible(window) != 0 && Marshal.PtrToStringUTF8(gtk_window_get_title(window)) == Title &&
                    !DetachedWindows.Contains(window))
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

    /// <summary>
    /// The window paints no background of its own: it's see-through (LinuxWindow), and the page rounds its corners
    /// (app.css). Else GTK's theme colour (white in a light theme) shows in the corners until the page has drawn, and
    /// again on some redraws, squaring them.
    /// </summary>
    public static void ClearBackground(IntPtr window)
    {
        gtk_widget_set_app_paintable(window, 1);
        var provider = gtk_css_provider_new();
        gtk_css_provider_load_from_data(provider, TransparentCss, -1, IntPtr.Zero);
        gtk_style_context_add_provider(gtk_widget_get_style_context(window), provider, StyleProviderPriorityApplication);
        g_object_unref(provider);
    }

    private const string TransparentCss = "window, window.background { background: transparent; }";
    /// <summary>GTK_STYLE_PROVIDER_PRIORITY_APPLICATION: over the theme's own.</summary>
    private const uint StyleProviderPriorityApplication = 600;

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
    [DllImport(Gtk)] private static extern void gtk_widget_set_app_paintable(IntPtr widget, int paintable);
    [DllImport(Gtk)] private static extern IntPtr gtk_css_provider_new();
    [DllImport(Gtk)] private static extern int gtk_css_provider_load_from_data(IntPtr provider, [MarshalAs(UnmanagedType.LPUTF8Str)] string data, nint length, IntPtr error);
    [DllImport(Gtk)] private static extern IntPtr gtk_widget_get_style_context(IntPtr widget);
    [DllImport(Gtk)] private static extern void gtk_style_context_add_provider(IntPtr context, IntPtr provider, uint priority);
    [DllImport(GObjectName)] private static extern void g_object_unref(IntPtr instance);
    [DllImport(GLib)] private static extern void g_list_free(IntPtr list);
    [DllImport(GLib)] private static extern void g_set_prgname([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(GLib)] private static extern void g_set_application_name([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
}
