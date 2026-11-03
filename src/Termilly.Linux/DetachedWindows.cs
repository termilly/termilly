using System.Runtime.InteropServices;
using Termilly.Desktop.Messaging;

namespace Termilly.Linux;

/// <summary>
/// A terminal, the Notepad or the Snippets window in a window of its own on Linux (js/windows.js), as DetachedWindow
/// is on Windows. Photino doesn't let a page open windows, so this answers WebKitGTK's "create" signal itself: for the
/// page's own windows only (named so), a web view related to the page's (same process and context, so window.opener and
/// the app:// scheme work) in a GTK window with no title bar of its own: the element's header is it, and the page asks
/// for moves, sizes, minimize and maximize (<see cref="Act"/>). The page builds the window's empty page, moves its
/// element in and keeps running it; closing the window asks the page first (the termillyClose it gives the window),
/// which takes the element back and closes it. Everything here runs on GTK's thread.
/// </summary>
internal static class DetachedWindows
{
    private const string Gtk = "libgtk-3.so.0";
    private const string GObject = "libgobject-2.0.so.0";
    private const string WebKit = "libwebkit2gtk-4.1.so.0";
    /// <summary>What the window runs when the user closes it: the page closes it once it has taken back what it shows.</summary>
    private const string AskToClose = "window.termillyClose ? termillyClose() : window.close()";
    private const int GtkWindowToplevel = 0;

    /// <summary>A window open: its GTK window, window.open's name for it, and whether the page has closed it.</summary>
    private sealed class Opened(IntPtr window, string name)
    {
        public IntPtr Window { get; } = window;
        public string Name { get; } = name;
        public bool ClosedByPage { get; set; }
    }

    /// <summary>The windows by their web view.</summary>
    private static readonly Dictionary<IntPtr, Opened> Open = [];
    /// <summary>Names of windows asked for, by their web view, until they're ready to show.</summary>
    private static readonly Dictionary<IntPtr, string> Pending = [];

    // The callbacks GTK holds: kept here so they're never collected.
    private static readonly CreateCallback OnCreate = Create;
    private static readonly ViewCallback OnReadyToShow = ReadyToShow;
    private static readonly ViewCallback OnClose = CloseFromPage;
    private static readonly NotifyCallback OnTitle = TitleChanged;
    private static readonly DeleteCallback OnDelete = DeleteRequested;

    private delegate IntPtr CreateCallback(IntPtr view, IntPtr navigation, IntPtr data);
    private delegate void ViewCallback(IntPtr view, IntPtr data);
    private delegate void NotifyCallback(IntPtr view, IntPtr spec, IntPtr data);
    private delegate int DeleteCallback(IntPtr window, IntPtr gdkEvent, IntPtr data);

    /// <summary>Lets the page in <paramref name="mainWindow"/> open its windows. False when it holds no web view to hook.</summary>
    public static bool Hook(IntPtr mainWindow)
    {
        var view = gtk_bin_get_child(mainWindow);
        if (view == IntPtr.Zero)
        {
            return false;
        }
        g_signal_connect_data(view, "create", OnCreate, IntPtr.Zero, IntPtr.Zero, 0);
        return true;
    }

    /// <summary>Whether a GTK window is one of these (GtkWindow.Find looks for the main one).</summary>
    public static bool Contains(IntPtr window) => Open.Values.Any(o => o.Window == window);

    /// <summary>
    /// What a window's title bar (the page's header) asks, for the window window.open named <paramref name="name"/>:
    /// minimize, maximize or restore, move, resize from an edge, or come to the front.
    /// </summary>
    public static void Act(string? name, string? action, string? edge)
    {
        if (Open.Values.FirstOrDefault(o => o.Name == name) is not { } opened)
        {
            return;
        }
        var window = opened.Window;
        switch (action)
        {
            case WindowActions.Minimize:
                gtk_window_iconify(window);
                break;
            case WindowActions.Maximize when gtk_window_is_maximized(window) != 0:
                gtk_window_unmaximize(window);
                break;
            case WindowActions.Maximize:
                gtk_window_maximize(window);
                break;
            case WindowActions.Drag:
                GtkWindow.BeginMove(window);
                break;
            case WindowActions.Resize when edge is not null && gtk_window_is_maximized(window) == 0:
                GtkWindow.BeginResize(edge, window);
                break;
            case WindowActions.Focus:
                gtk_window_present(window);
                break;
        }
    }

    /// <summary>Closes them all, without asking the page: the main window is closing, and the page with it.</summary>
    public static void CloseAll()
    {
        foreach (var opened in Open.Values.ToList())
        {
            opened.ClosedByPage = true;
            gtk_widget_destroy(opened.Window);
        }
        Open.Clear();
    }

    /// <summary>window.open: a related web view for one of the page's own windows, nothing (no window) for anything else.</summary>
    private static IntPtr Create(IntPtr view, IntPtr navigation, IntPtr data)
    {
        var name = Marshal.PtrToStringUTF8(webkit_navigation_action_get_frame_name(navigation));
        if (name is null || !name.StartsWith(DetachedWindowNames.NamePrefix, StringComparison.Ordinal))
        {
            return IntPtr.Zero;
        }
        var opened = webkit_web_view_new_with_related_view(view);
        Pending[opened] = name;
        g_signal_connect_data(opened, "ready-to-show", OnReadyToShow, IntPtr.Zero, IntPtr.Zero, 0);
        g_signal_connect_data(opened, "close", OnClose, IntPtr.Zero, IntPtr.Zero, 0);
        g_signal_connect_data(opened, "notify::title", OnTitle, IntPtr.Zero, IntPtr.Zero, 0);
        return opened;
    }

    /// <summary>The page in it is ready: a window at the size (and place) window.open asked for, in the theme.</summary>
    private static void ReadyToShow(IntPtr view, IntPtr data)
    {
        if (!Pending.Remove(view, out var name))
        {
            return;
        }
        var window = gtk_window_new(GtkWindowToplevel);
        gtk_window_set_decorated(window, 0); // the page's header is its title bar
        webkit_window_properties_get_geometry(webkit_web_view_get_window_properties(view), out var geometry);
        if (geometry.Width > 0 && geometry.Height > 0)
        {
            gtk_window_set_default_size(window, geometry.Width, geometry.Height);
        }
        if (geometry.X > 0 || geometry.Y > 0)
        {
            gtk_window_move(window, geometry.X, geometry.Y); // X11 only: Wayland places windows itself
        }
        gtk_window_set_title(window, Marshal.PtrToStringUTF8(webkit_web_view_get_title(view)) ?? GtkWindow.Title);
        gtk_container_add(window, view);
        Open[view] = new Opened(window, name);
        g_signal_connect_data(window, "delete-event", OnDelete, view, IntPtr.Zero, 0);
        gtk_widget_show_all(window);
    }

    /// <summary>window.close() in its page (it has taken back what it showed): the window goes.</summary>
    private static void CloseFromPage(IntPtr view, IntPtr data)
    {
        if (Open.Remove(view, out var opened))
        {
            opened.ClosedByPage = true;
            gtk_widget_destroy(opened.Window);
        }
    }

    private static void TitleChanged(IntPtr view, IntPtr spec, IntPtr data)
    {
        if (Open.TryGetValue(view, out var opened) && Marshal.PtrToStringUTF8(webkit_web_view_get_title(view)) is { Length: > 0 } title)
        {
            gtk_window_set_title(opened.Window, title);
        }
    }

    /// <summary>The title bar's close: the page is asked, and closes the window itself (true keeps it for now).</summary>
    private static int DeleteRequested(IntPtr window, IntPtr gdkEvent, IntPtr view)
    {
        if (!Open.TryGetValue(view, out var opened) || opened.ClosedByPage)
        {
            return 0;
        }
        webkit_web_view_run_javascript(view, AskToClose, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero);
        return 1;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct GdkRectangle
    {
        public int X;
        public int Y;
        public int Width;
        public int Height;
    }

    [DllImport(GObject)] private static extern ulong g_signal_connect_data(IntPtr instance, [MarshalAs(UnmanagedType.LPUTF8Str)] string signal, Delegate handler, IntPtr data, IntPtr destroy, int flags);
    [DllImport(Gtk)] private static extern IntPtr gtk_bin_get_child(IntPtr bin);
    [DllImport(Gtk)] private static extern IntPtr gtk_window_new(int type);
    [DllImport(Gtk)] private static extern void gtk_window_set_default_size(IntPtr window, int width, int height);
    [DllImport(Gtk)] private static extern void gtk_window_move(IntPtr window, int x, int y);
    [DllImport(Gtk)] private static extern void gtk_window_set_title(IntPtr window, [MarshalAs(UnmanagedType.LPUTF8Str)] string title);
    [DllImport(Gtk)] private static extern void gtk_window_present(IntPtr window);
    [DllImport(Gtk)] private static extern void gtk_container_add(IntPtr container, IntPtr widget);
    [DllImport(Gtk)] private static extern void gtk_widget_show_all(IntPtr widget);
    [DllImport(Gtk)] private static extern void gtk_widget_destroy(IntPtr widget);
    [DllImport(Gtk)] private static extern void gtk_window_set_decorated(IntPtr window, int decorated);
    [DllImport(Gtk)] private static extern void gtk_window_iconify(IntPtr window);
    [DllImport(Gtk)] private static extern void gtk_window_maximize(IntPtr window);
    [DllImport(Gtk)] private static extern void gtk_window_unmaximize(IntPtr window);
    [DllImport(Gtk)] private static extern int gtk_window_is_maximized(IntPtr window);
    [DllImport(WebKit)] private static extern IntPtr webkit_web_view_new_with_related_view(IntPtr view);
    [DllImport(WebKit)] private static extern IntPtr webkit_web_view_get_title(IntPtr view);
    [DllImport(WebKit)] private static extern IntPtr webkit_web_view_get_window_properties(IntPtr view);
    [DllImport(WebKit)] private static extern void webkit_window_properties_get_geometry(IntPtr properties, out GdkRectangle geometry);
    [DllImport(WebKit)] private static extern IntPtr webkit_navigation_action_get_frame_name(IntPtr navigation);
    [DllImport(WebKit)] private static extern void webkit_web_view_run_javascript(IntPtr view, [MarshalAs(UnmanagedType.LPUTF8Str)] string script, IntPtr cancellable, IntPtr callback, IntPtr data);
}
