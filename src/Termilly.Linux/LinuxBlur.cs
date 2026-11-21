using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Termilly.Desktop;

namespace Termilly.Linux;

/// <summary>
/// Blur behind a see-through window on Linux (Settings › Appearance › Background › Blur). Only KDE's compositor offers
/// it to other apps, through a window property on X11 (Termilly runs as an X11 app by default, XWayland on Wayland);
/// elsewhere the window is see-through without blur.
/// </summary>
[SupportedOSPlatform("linux")]
internal static class LinuxBlur
{
    private const string Gdk = "libgdk-3.so.0";
    private const string Gtk = "libgtk-3.so.0";

    /// <summary>KDE's property: present (empty, the whole window) to blur behind the window, removed to stop.</summary>
    private const string BlurProperty = "_KDE_NET_WM_BLUR_BEHIND_REGION";
    private const string CardinalType = "CARDINAL";
    private const int PropertyFormat = 32;
    private const int PropModeReplace = 0;

    private const string DesktopVariable = "XDG_CURRENT_DESKTOP";
    private const string Kde = "KDE";

    /// <summary>The effects Linux windows have here: blur on KDE (as X11 windows), else none beyond see-through.</summary>
    public static IReadOnlyList<string> Effects { get; } =
        (Environment.GetEnvironmentVariable(DesktopVariable) ?? "").Contains(Kde, StringComparison.OrdinalIgnoreCase) && GtkWindow.PlacesWindows
            ? [BackgroundValues.Effect.None, BackgroundValues.Effect.Blur]
            : [BackgroundValues.Effect.None];

    /// <summary>Blurs behind a GTK window, or stops; nothing before it's shown, or off X11.</summary>
    public static void Set(IntPtr window, bool on)
    {
        var gdkWindow = gtk_widget_get_window(window);
        if (gdkWindow == IntPtr.Zero)
        {
            return;
        }
        var property = Atom(BlurProperty);
        if (on)
        {
            gdk_property_change(gdkWindow, property, Atom(CardinalType), PropertyFormat, PropModeReplace, IntPtr.Zero, 0);
        }
        else
        {
            gdk_property_delete(gdkWindow, property);
        }
    }

    /// <summary>An X11 atom by its name, made if it isn't yet.</summary>
    private static IntPtr Atom(string name)
    {
        var utf8 = Marshal.StringToCoTaskMemUTF8(name);
        try
        {
            return gdk_atom_intern(utf8, 0);
        }
        finally
        {
            Marshal.FreeCoTaskMem(utf8);
        }
    }

    [DllImport(Gtk)] private static extern IntPtr gtk_widget_get_window(IntPtr widget);
    [DllImport(Gdk)] private static extern IntPtr gdk_atom_intern(IntPtr name, int onlyIfExists);
    [DllImport(Gdk)] private static extern void gdk_property_change(IntPtr window, IntPtr property, IntPtr type, int format, int mode, IntPtr data, int elements);
    [DllImport(Gdk)] private static extern void gdk_property_delete(IntPtr window, IntPtr property);
}
