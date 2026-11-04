using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Termilly.Desktop.Platform;

namespace Termilly.Linux;

/// <summary>
/// The clipboard's changes on macOS, for Clipboard: the text copied anywhere, as WindowsClipboard gives on Windows (no
/// images yet). macOS tells no app about a change, so its pasteboard's change count is looked at every so often. A copy
/// marked concealed (org.nspasteboard.ConcealedType, as password managers mark theirs) is left alone. Changes are told
/// on the window's thread.
/// </summary>
/// <param name="onWindow">Runs an action on the window's thread.</param>
[SupportedOSPlatform("macos")]
internal sealed class MacClipboard(Action<Action> onWindow) : IClipboardWatch, IDisposable
{
    private const string ObjC = "/usr/lib/libobjc.A.dylib";
    private const string AppKit = "/System/Library/Frameworks/AppKit.framework/AppKit";
    private const string TextType = "public.utf8-plain-text";
    private const string ConcealedType = "org.nspasteboard.ConcealedType";
    /// <summary>How often the pasteboard is looked at.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromMilliseconds(750);

    private Timer? _timer;
    private long _seen = -1;

    public event Action<ClipboardContent>? Changed;

    public void Start()
    {
        // AppKit has to be loaded for NSPasteboard's class to be found.
        NativeLibrary.TryLoad(AppKit, out _);
        _timer = new Timer(_ => Look(), null, Every, Every);
    }

    private void Look()
    {
        var board = Send(Class("NSPasteboard"), "generalPasteboard");
        if (board == IntPtr.Zero)
        {
            return;
        }
        var count = (long)Send(board, "changeCount");
        if (count == _seen)
        {
            return;
        }
        var first = _seen < 0;
        _seen = count;
        if (first || Concealed(board))
        {
            return; // what was there before Termilly started, or a secret
        }
        var text = Utf8(SendWith(board, "stringForType:", NsString(TextType)));
        if (text is { Length: > 0 })
        {
            onWindow(() => Changed?.Invoke(new ClipboardContent(text)));
        }
    }

    /// <summary>Whether the copy is marked concealed.</summary>
    private static bool Concealed(IntPtr board)
    {
        var types = Send(board, "types");
        var count = types == IntPtr.Zero ? 0 : (long)Send(types, "count");
        for (long i = 0; i < count; i++)
        {
            if (Utf8(SendIndex(types, "objectAtIndex:", (nint)i)) == ConcealedType)
            {
                return true;
            }
        }
        return false;
    }

    private static IntPtr Class(string name) => objc_getClass(name);

    private static IntPtr NsString(string text)
    {
        var utf8 = Marshal.StringToCoTaskMemUTF8(text);
        try
        {
            return SendWith(Class("NSString"), "stringWithUTF8String:", utf8);
        }
        finally
        {
            Marshal.FreeCoTaskMem(utf8);
        }
    }

    private static string? Utf8(IntPtr nsString) =>
        nsString == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(Send(nsString, "UTF8String"));

    private static IntPtr Send(IntPtr target, string selector) => objc_msgSend(target, sel_registerName(selector));

    private static IntPtr SendWith(IntPtr target, string selector, IntPtr argument) =>
        objc_msgSend_ptr(target, sel_registerName(selector), argument);

    private static IntPtr SendIndex(IntPtr target, string selector, nint index) =>
        objc_msgSend_index(target, sel_registerName(selector), index);

    public void Dispose() => _timer?.Dispose();

    [DllImport(ObjC)] private static extern IntPtr objc_getClass([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(ObjC)] private static extern IntPtr sel_registerName([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(ObjC)] private static extern IntPtr objc_msgSend(IntPtr target, IntPtr selector);
    [DllImport(ObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr objc_msgSend_ptr(IntPtr target, IntPtr selector, IntPtr argument);
    [DllImport(ObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr objc_msgSend_index(IntPtr target, IntPtr selector, nint index);
}
