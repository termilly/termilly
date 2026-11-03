using System.Runtime.InteropServices;

namespace Termilly.Linux;

/// <summary>
/// A picture of the main window's page as it shows now, a JPEG in base64, as WebView2's CapturePreviewAsync gives on
/// Windows (a terminal dragged out shows it in the outline of its window, js/panes.js): WebKitGTK's snapshot of the
/// visible part, made a JPEG by GdkPixbuf. Linux only (macOS has no GTK). Start it on the window's (GTK) thread.
/// </summary>
internal static class PageSnapshot
{
    private const string Gtk = "libgtk-3.so.0";
    private const string Gdk = "libgdk-3.so.0";
    private const string Pixbuf = "libgdk_pixbuf-2.0.so.0";
    private const string Cairo = "libcairo.so.2";
    private const string GLib = "libglib-2.0.so.0";
    private const string GObject = "libgobject-2.0.so.0";
    private const string WebKit = "libwebkit2gtk-4.1.so.0";
    /// <summary>WEBKIT_SNAPSHOT_REGION_VISIBLE and WEBKIT_SNAPSHOT_OPTIONS_NONE.</summary>
    private const int VisibleRegion = 0, NoOptions = 0;
    /// <summary>GdkPixbuf's name for the format, as C wants it (UTF-8, ending in a zero).</summary>
    private static readonly byte[] Jpeg = [.. "jpeg"u8, 0];

    private delegate void ReadyCallback(IntPtr source, IntPtr result, IntPtr data);

    /// <summary>Kept here so GTK's pointer to it is never collected.</summary>
    private static readonly ReadyCallback OnReady = Ready;

    /// <summary>Starts the picture of <paramref name="window"/>'s page; <paramref name="done"/> gets it, or null when none could be taken.</summary>
    public static void Take(IntPtr window, TaskCompletionSource<string?> done)
    {
        var view = gtk_bin_get_child(window);
        if (view == IntPtr.Zero)
        {
            done.TrySetResult(null);
            return;
        }
        var handle = GCHandle.Alloc(done);
        webkit_web_view_get_snapshot(view, VisibleRegion, NoOptions, IntPtr.Zero, OnReady, GCHandle.ToIntPtr(handle));
    }

    private static void Ready(IntPtr view, IntPtr result, IntPtr data)
    {
        var handle = GCHandle.FromIntPtr(data);
        var done = (TaskCompletionSource<string?>)handle.Target!;
        handle.Free();
        var surface = webkit_web_view_get_snapshot_finish(view, result, out var error);
        if (error != IntPtr.Zero)
        {
            g_error_free(error);
        }
        if (surface == IntPtr.Zero)
        {
            done.TrySetResult(null);
            return;
        }
        try
        {
            done.TrySetResult(Encode(surface));
        }
        finally
        {
            cairo_surface_destroy(surface);
        }
    }

    /// <summary>The picture as a JPEG in base64; null when it can't be made one.</summary>
    private static string? Encode(IntPtr surface)
    {
        var width = cairo_image_surface_get_width(surface);
        var height = cairo_image_surface_get_height(surface);
        var pixbuf = width > 0 && height > 0 ? gdk_pixbuf_get_from_surface(surface, 0, 0, width, height) : IntPtr.Zero;
        if (pixbuf == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            if (gdk_pixbuf_save_to_bufferv(pixbuf, out var buffer, out var size, Jpeg, IntPtr.Zero, IntPtr.Zero, out var error) == 0)
            {
                if (error != IntPtr.Zero)
                {
                    g_error_free(error);
                }
                return null;
            }
            var bytes = new byte[(int)size];
            Marshal.Copy(buffer, bytes, 0, bytes.Length);
            g_free(buffer);
            return Convert.ToBase64String(bytes);
        }
        finally
        {
            g_object_unref(pixbuf);
        }
    }

    [DllImport(Gtk)] private static extern IntPtr gtk_bin_get_child(IntPtr bin);
    [DllImport(WebKit)] private static extern void webkit_web_view_get_snapshot(IntPtr view, int region, int options, IntPtr cancellable, ReadyCallback callback, IntPtr data);
    [DllImport(WebKit)] private static extern IntPtr webkit_web_view_get_snapshot_finish(IntPtr view, IntPtr result, out IntPtr error);
    [DllImport(Cairo)] private static extern int cairo_image_surface_get_width(IntPtr surface);
    [DllImport(Cairo)] private static extern int cairo_image_surface_get_height(IntPtr surface);
    [DllImport(Cairo)] private static extern void cairo_surface_destroy(IntPtr surface);
    [DllImport(Gdk)] private static extern IntPtr gdk_pixbuf_get_from_surface(IntPtr surface, int x, int y, int width, int height);
    [DllImport(Pixbuf)]
    private static extern int gdk_pixbuf_save_to_bufferv(IntPtr pixbuf, out IntPtr buffer, out nuint size,
        byte[] type,
        IntPtr keys, IntPtr values, out IntPtr error); // no options: GdkPixbuf's own quality (75)
    [DllImport(GLib)] private static extern void g_free(IntPtr memory);
    [DllImport(GLib)] private static extern void g_error_free(IntPtr error);
    [DllImport(GObject)] private static extern void g_object_unref(IntPtr instance);
}
