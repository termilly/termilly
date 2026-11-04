using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Termilly.Linux;

/// <summary>
/// The Objective-C runtime, for the bits of AppKit and WebKit Photino doesn't reach (MacWindows): classes, selectors,
/// messages with the argument shapes used here, and methods added to a class. Rectangles are Cocoa's: from the bottom
/// left of the main screen, in points.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacObjC
{
    private const string LibObjC = "/usr/lib/libobjc.A.dylib";
    private const string AppKit = "/System/Library/Frameworks/AppKit.framework/AppKit";
    private const string WebKit = "/System/Library/Frameworks/WebKit.framework/WebKit";

    /// <summary>The names of the classes and messages used in more than one place.</summary>
    public static class Cocoa
    {
        public const string Alloc = "alloc";
        public const string Count = "count";
        public const string ObjectAtIndex = "objectAtIndex:";
        public const string Frame = "frame";
        public const string Close = "close";
        public const string ContentView = "contentView";
        public const string MakeKeyAndOrderFront = "makeKeyAndOrderFront:";
        public const string SetMagnification = "setMagnification:";
        public const string Application = "NSApplication";
        public const string SharedApplication = "sharedApplication";
        public const string Screen = "NSScreen";
        public const string Screens = "screens";
    }

    /// <summary>A rectangle as Cocoa gives and takes it (CGRect / NSRect).</summary>
    [StructLayout(LayoutKind.Sequential)]
    public readonly record struct Rect(double X, double Y, double Width, double Height);

    /// <summary>Loads AppKit and WebKit, whose classes are looked up by name.</summary>
    public static void Load()
    {
        NativeLibrary.TryLoad(AppKit, out _);
        NativeLibrary.TryLoad(WebKit, out _);
    }

    public static IntPtr Class(string name) => objc_getClass(name);

    public static IntPtr Sel(string name) => sel_registerName(name);

    public static IntPtr Send(IntPtr target, string selector) => target == IntPtr.Zero ? IntPtr.Zero : msgSend(target, Sel(selector));

    public static IntPtr Send(IntPtr target, string selector, IntPtr argument) =>
        target == IntPtr.Zero ? IntPtr.Zero : msgSend(target, Sel(selector), argument);

    public static IntPtr Send(IntPtr target, string selector, IntPtr first, IntPtr second) =>
        target == IntPtr.Zero ? IntPtr.Zero : msgSend(target, Sel(selector), first, second);

    public static void Send(IntPtr target, string selector, bool value)
    {
        if (target != IntPtr.Zero)
        {
            msgSend_bool(target, Sel(selector), value ? (byte)1 : (byte)0);
        }
    }

    public static void Send(IntPtr target, string selector, double value)
    {
        if (target != IntPtr.Zero)
        {
            msgSend_double(target, Sel(selector), value);
        }
    }

    public static bool SendBool(IntPtr target, string selector) => target != IntPtr.Zero && msgSend_getBool(target, Sel(selector)) != 0;

    public static bool SendBool(IntPtr target, string selector, IntPtr argument) =>
        target != IntPtr.Zero && msgSend_getBoolWith(target, Sel(selector), argument) != 0;

    public static double SendDouble(IntPtr target, string selector) => target == IntPtr.Zero ? 0 : msgSend_getDouble(target, Sel(selector));

    /// <summary>A message that answers a rectangle: on Intel Macs it comes back through memory (objc_msgSend_stret).</summary>
    public static Rect SendRect(IntPtr target, string selector)
    {
        if (target == IntPtr.Zero)
        {
            return default;
        }
        if (RuntimeInformation.ProcessArchitecture == Architecture.X64)
        {
            msgSend_stret(out var rect, target, Sel(selector));
            return rect;
        }
        return msgSend_getRect(target, Sel(selector));
    }

    /// <summary>setFrame:display:.</summary>
    public static void SetFrame(IntPtr window, Rect frame) => msgSend_rectBool(window, Sel("setFrame:display:"), frame, 1);

    /// <summary>initWithFrame:configuration: (WKWebView), initWithFrame: when there's no configuration.</summary>
    public static IntPtr InitWithFrame(IntPtr allocated, Rect frame, IntPtr configuration) => configuration == IntPtr.Zero
        ? msgSend_rect(allocated, Sel("initWithFrame:"), frame)
        : msgSend_rectPtr(allocated, Sel("initWithFrame:configuration:"), frame, configuration);

    /// <summary>NSWindow's initWithContentRect:styleMask:backing:defer:.</summary>
    public static IntPtr InitWindow(IntPtr allocated, Rect frame, nuint styleMask) =>
        msgSend_window(allocated, Sel("initWithContentRect:styleMask:backing:defer:"), frame, styleMask, BackingStoreBuffered, 0);

    private const nuint BackingStoreBuffered = 2;

    /// <summary>An NSString (autoreleased) of <paramref name="text"/>.</summary>
    public static IntPtr NsString(string text)
    {
        var utf8 = Marshal.StringToCoTaskMemUTF8(text);
        try
        {
            return Send(Class("NSString"), "stringWithUTF8String:", utf8);
        }
        finally
        {
            Marshal.FreeCoTaskMem(utf8);
        }
    }

    /// <summary>An NSString's text, null for nil.</summary>
    public static string? Text(IntPtr nsString) =>
        nsString == IntPtr.Zero ? null : Marshal.PtrToStringUTF8(Send(nsString, "UTF8String"));

    /// <summary>
    /// Gives <paramref name="cls"/> a method (or replaces the one it has): <paramref name="implementation"/> must be
    /// kept alive as long as the app runs. <paramref name="types"/> is its Objective-C type encoding.
    /// </summary>
    public static void AddMethod(IntPtr cls, string selector, Delegate implementation, string types) =>
        class_replaceMethod(cls, Sel(selector), Marshal.GetFunctionPointerForDelegate(implementation), types);

    /// <summary>An object's class.</summary>
    public static IntPtr ClassOf(IntPtr instance) => object_getClass(instance);

    [DllImport(LibObjC)] private static extern IntPtr objc_getClass([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(LibObjC)] private static extern IntPtr sel_registerName([MarshalAs(UnmanagedType.LPUTF8Str)] string name);
    [DllImport(LibObjC)] private static extern IntPtr object_getClass(IntPtr instance);
    [DllImport(LibObjC)] private static extern IntPtr class_replaceMethod(IntPtr cls, IntPtr selector, IntPtr implementation, [MarshalAs(UnmanagedType.LPUTF8Str)] string types);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend(IntPtr target, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend(IntPtr target, IntPtr selector, IntPtr argument);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend(IntPtr target, IntPtr selector, IntPtr first, IntPtr second);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern void msgSend_bool(IntPtr target, IntPtr selector, byte argument);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern void msgSend_double(IntPtr target, IntPtr selector, double argument);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern byte msgSend_getBool(IntPtr target, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern byte msgSend_getBoolWith(IntPtr target, IntPtr selector, IntPtr argument);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern double msgSend_getDouble(IntPtr target, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern Rect msgSend_getRect(IntPtr target, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend_stret")] private static extern void msgSend_stret(out Rect rect, IntPtr target, IntPtr selector);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern void msgSend_rectBool(IntPtr target, IntPtr selector, Rect rect, byte flag);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend_rect(IntPtr target, IntPtr selector, Rect rect);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend_rectPtr(IntPtr target, IntPtr selector, Rect rect, IntPtr argument);
    [DllImport(LibObjC, EntryPoint = "objc_msgSend")] private static extern IntPtr msgSend_window(IntPtr target, IntPtr selector, Rect rect, nuint styleMask, nuint backing, byte defer);
}
