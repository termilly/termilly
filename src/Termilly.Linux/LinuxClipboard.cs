using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Termilly.Desktop.Platform;

namespace Termilly.Linux;

/// <summary>
/// The clipboard's changes on Linux (GTK's owner-change), for Clipboard: the text copied anywhere, as WindowsClipboard
/// gives on Windows (no images yet). A copy a password manager marks as secret (x-kde-passwordManagerHint, as KeePassXC
/// and KDE's own do) is left alone. Everything here runs on GTK's thread.
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed class LinuxClipboard : IClipboardWatch
{
    private const string Gtk = "libgtk-3.so.0";
    private const string Gdk = "libgdk-3.so.0";
    private const string GLib = "libglib-2.0.so.0";
    private const string GObject = "libgobject-2.0.so.0";
    private const string ClipboardName = "CLIPBOARD";
    /// <summary>What a password manager sets on a secret it copies.</summary>
    private const string SecretHint = "x-kde-passwordManagerHint";

    private delegate int SourceCallback(IntPtr data);
    private delegate void OwnerChangeCallback(IntPtr clipboard, IntPtr gdkEvent, IntPtr data);
    private delegate void TargetsCallback(IntPtr clipboard, IntPtr atoms, int count, IntPtr data);
    private delegate void TextCallback(IntPtr clipboard, IntPtr text, IntPtr data);

    // Kept here so GTK's pointers to them are never collected.
    private readonly SourceCallback _onStart;
    private readonly OwnerChangeCallback _onOwnerChange;
    private readonly TargetsCallback _onTargets;
    private readonly TextCallback _onText;

    public LinuxClipboard()
    {
        _onStart = _ => Listen();
        _onOwnerChange = (clipboard, _, _) => gtk_clipboard_request_targets(clipboard, _onTargets!, IntPtr.Zero);
        _onTargets = OnTargets;
        _onText = OnText;
    }

    public event Action<ClipboardContent>? Changed;

    /// <summary>Listens from GTK's own loop (once it runs, whichever thread asks).</summary>
    public void Start() => g_idle_add(_onStart, IntPtr.Zero);

    private int Listen()
    {
        var clipboard = gtk_clipboard_get(gdk_atom_intern(ClipboardName, 0));
        if (clipboard != IntPtr.Zero)
        {
            g_signal_connect_data(clipboard, "owner-change", _onOwnerChange, IntPtr.Zero, IntPtr.Zero, 0);
        }
        return 0; // once
    }

    /// <summary>What the copy offers: a secret is left alone, anything else is read as text.</summary>
    private void OnTargets(IntPtr clipboard, IntPtr atoms, int count, IntPtr data)
    {
        for (var i = 0; i < count; i++)
        {
            var name = gdk_atom_name(Marshal.ReadIntPtr(atoms, i * IntPtr.Size));
            var secret = Marshal.PtrToStringUTF8(name) == SecretHint;
            g_free(name);
            if (secret)
            {
                return;
            }
        }
        gtk_clipboard_request_text(clipboard, _onText, IntPtr.Zero);
    }

    private void OnText(IntPtr clipboard, IntPtr text, IntPtr data)
    {
        if (Marshal.PtrToStringUTF8(text) is { Length: > 0 } copied)
        {
            Changed?.Invoke(new ClipboardContent(copied));
        }
    }

    [DllImport(Gdk)] private static extern IntPtr gdk_atom_intern([MarshalAs(UnmanagedType.LPUTF8Str)] string name, int onlyIfExists);
    [DllImport(Gdk)] private static extern IntPtr gdk_atom_name(IntPtr atom);
    [DllImport(Gtk)] private static extern IntPtr gtk_clipboard_get(IntPtr selection);
    [DllImport(Gtk)] private static extern void gtk_clipboard_request_targets(IntPtr clipboard, TargetsCallback callback, IntPtr data);
    [DllImport(Gtk)] private static extern void gtk_clipboard_request_text(IntPtr clipboard, TextCallback callback, IntPtr data);
    [DllImport(GLib)] private static extern uint g_idle_add(SourceCallback callback, IntPtr data);
    [DllImport(GLib)] private static extern void g_free(IntPtr memory);
    [DllImport(GObject)] private static extern ulong g_signal_connect_data(IntPtr instance, [MarshalAs(UnmanagedType.LPUTF8Str)] string signal, Delegate handler, IntPtr data, IntPtr destroy, int flags);
}
