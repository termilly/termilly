using System.Runtime.Versioning;
using Termilly.Desktop.Messaging;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// Termilly's windows on macOS, past what Photino does: rounded corners with the system's shadow (the window is
/// see-through and its content clipped round, square while maximized), maximize and restore (Photino fills the screen
/// but never says it did, so Restore never came), and the page's own windows (js/windows.js), as DetachedWindows does
/// on Linux. Photino's web view has no answer to window.open, so its UI delegate gets one: for an empty page (the page's
/// own windows open about:blank) a web view of the same configuration (same process, so window.opener works) in a
/// window with no title bar; the page then names it (<see cref="Named"/>) and asks for moves, sizes, minimize and
/// maximize by that name (<see cref="Act"/>). window.close() in its page closes it. Everything here runs on the main
/// thread.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacWindows
{
    /// <summary>The corners' radius, in points: app.css's --radius.</summary>
    private const double CornerRadius = 10;
    /// <summary>NSWindowStyleMask: borderless, closable, miniaturizable, resizable.</summary>
    private const nuint DetachedStyle = 2 | 4 | 8;
    /// <summary>NSViewWidthSizable | NSViewHeightSizable.</summary>
    private const nuint FillParent = 2 | 16;
    /// <summary>NSFloatingWindowLevel and NSNormalWindowLevel.</summary>
    private const nint FloatingLevel = 3;
    private const nint NormalLevel = 0;
    private const double FadedAlpha = 0.5;
    private const double SolidAlpha = 1;
    /// <summary>WKWindowFeatures' sizes, and NSApplication's windows.</summary>
    private static class Features
    {
        public const string Width = "width";
        public const string Height = "height";
        public const string Windows = "windows";
    }
    private const string BlankPage = "about:blank";
    /// <summary>Photino's borderless window class (it may become the key window); NSWindow if it's ever gone.</summary>
    private const string BorderlessWindowClass = "NSWindowBorderless";
    private const string WebViewClass = "WKWebView";
    /// <summary>The smallest a page's window gets by its edges, in points.</summary>
    private static readonly System.Drawing.Size DetachedMinSize = new(320, 160);

    /// <summary>A page's window: its NSWindow and web view, and the name window.open gave it (once the page said it).</summary>
    private sealed class Opened(IntPtr window, IntPtr view)
    {
        public IntPtr Window { get; } = window;
        public IntPtr View { get; } = view;
        public string? Name { get; set; }
    }

    private static readonly List<Opened> Open = [];
    /// <summary>The frames maximized windows had before, to restore them.</summary>
    private static readonly Dictionary<IntPtr, Rect> Restore = [];

    // The methods added to Photino's UI delegate: kept here so they're never collected.
    private static readonly CreateWebView OnCreate = Create;
    private static readonly WebViewClosed OnClose = Closed;
    private static readonly WindowClosing OnMainClosing = MainClosing;

    private delegate IntPtr CreateWebView(IntPtr self, IntPtr selector, IntPtr webView, IntPtr configuration, IntPtr action, IntPtr features);
    private delegate void WebViewClosed(IntPtr self, IntPtr selector, IntPtr webView);
    private delegate void WindowClosing(IntPtr self, IntPtr selector, IntPtr notification);

    /// <summary>The method added to Photino's UI delegate that hears the main window close.</summary>
    private const string MainClosingSelector = "termillyMainWindowWillClose:";
    /// <summary>The types of a method that takes an object and returns nothing.</summary>
    private const string VoidWithObject = "v@:@";

    /// <summary>The main window (Photino's), once <see cref="Hook"/> found it.</summary>
    public static IntPtr Main { get; private set; }
    /// <summary>The main window's web view.</summary>
    private static IntPtr _mainView;

    private static double _zoom = 1;
    /// <summary>A web view drawn at its own size (the app's size is its page zoom instead).</summary>
    private const double NotMagnified = 1.0;
    private static Action<Action>? _onMain;

    /// <summary>
    /// Where a page's window is now and its size, after it was moved or resized: its window.open name, its place from
    /// the main screen's top left and size, in points. LinuxWindow posts it to the page.
    /// </summary>
    public static Action<string, double, double, double, double>? Placed { get; set; }

    /// <summary>
    /// Finds the main window and its web view (the window's thread, once Photino made them): its corners rounded, and
    /// its page may open windows of its own. <paramref name="onMain"/> runs an action on the main thread.
    /// </summary>
    public static void Hook(Action<Action> onMain, double zoom)
    {
        _onMain = onMain;
        _zoom = zoom;
        Load();
        var windows = Send(Send(Class(Cocoa.Application), Cocoa.SharedApplication), Features.Windows);
        var count = (nint)Send(windows, Cocoa.Count);
        for (nint i = 0; i < count && Main == IntPtr.Zero; i++)
        {
            var window = Send(windows, Cocoa.ObjectAtIndex, i);
            if (WebViewIn(window) is var view && view != IntPtr.Zero)
            {
                Main = window;
                _mainView = view;
                Zoom(view, _zoom);
                MacWindowDrag.TakeFirstClickOnTitleBar(() => _zoom);
                Round(window, true);
                MacPlacement.Restore(window);
                var preferences = Send(Send(view, "configuration"), "preferences");
                // The page reopens its windows as it starts (where they were before a restart): without a click first.
                Send(preferences, "setJavaScriptCanOpenWindowsAutomatically:", true);
                var uiDelegate = Send(view, "UIDelegate");
                var cls = ClassOf(uiDelegate);
                if (cls != IntPtr.Zero)
                {
                    AddMethod(cls, "webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:", OnCreate, "@@:@@@@");
                    AddMethod(cls, "webViewDidClose:", OnClose, VoidWithObject);
                    // WebKit looks at what its delegate answers only when it's set: set again, it sees the new methods.
                    // (The delegate stays alive: Photino's script message handler holds it.)
                    Send(view, SetUIDelegate, IntPtr.Zero);
                    Send(view, SetUIDelegate, uiDelegate);
                    // However the main window goes (its Close, which may skip the closing handler, or the system's),
                    // the page's windows go with it: else the app runs on, with them, after its window is gone.
                    AddMethod(cls, MainClosingSelector, OnMainClosing, VoidWithObject);
                    Send(Send(Class("NSNotificationCenter"), "defaultCenter"), "addObserver:selector:name:object:",
                        uiDelegate, Sel(MainClosingSelector), NsString("NSWindowWillCloseNotification"), window);
                }
            }
        }
    }

    /// <summary>The web view in a window's content view (Photino puts it there as a subview), or nothing.</summary>
    private static IntPtr WebViewIn(IntPtr window)
    {
        var subviews = Send(Send(window, Cocoa.ContentView), "subviews");
        var webView = Class(WebViewClass);
        var count = (nint)Send(subviews, Cocoa.Count);
        for (nint i = 0; i < count; i++)
        {
            var view = Send(subviews, Cocoa.ObjectAtIndex, i);
            if (SendBool(view, Cocoa.IsKindOfClass, webView))
            {
                return view;
            }
        }
        return IntPtr.Zero;
    }

    /// <summary>
    /// The window's corners round (or square, maximized): it's see-through, its content clipped to the rounded shape,
    /// and its shadow follows that shape.
    /// </summary>
    private static void Round(IntPtr window, bool round)
    {
        var content = Send(window, Cocoa.ContentView);
        Send(content, "setWantsLayer:", true);
        var layer = Send(content, "layer");
        Send(layer, "setCornerRadius:", round ? CornerRadius : 0);
        Send(layer, "setMasksToBounds:", true);
        Send(window, "setOpaque:", false);
        Send(window, "setBackgroundColor:", Send(Class("NSColor"), "clearColor"));
        Send(window, "setHasShadow:", true);
        Send(window, "invalidateShadow");
    }

    /// <summary>The whole app's size changed (1 is as designed): the page's windows at it, now and later.</summary>
    public static void SetZoom(double factor)
    {
        _zoom = factor;
        Zoom(_mainView, factor);
        foreach (var opened in Open)
        {
            Zoom(opened.View, factor);
        }
    }

    /// <summary>
    /// A web view at the app's size, laid out again as the browser's zoom does (pageZoom, macOS 11 and later), not
    /// magnified: magnified, the page is drawn bigger than its window and runs off it.
    /// </summary>
    private static void Zoom(IntPtr view, double factor)
    {
        if (view == IntPtr.Zero)
        {
            return;
        }
        if (SendBool(view, Cocoa.RespondsToSelector, Sel(Cocoa.SetPageZoom)))
        {
            Send(view, Cocoa.SetMagnification, NotMagnified);
            Send(view, Cocoa.SetPageZoom, factor);
        }
        else
        {
            Send(view, Cocoa.SetMagnification, factor);
        }
    }

    // ---- Maximize ----

    public static bool IsMaximized(IntPtr window) => Restore.ContainsKey(window);

    /// <summary>Maximized: the frame it had before comes back; else it fills its screen but the Dock and the menu bar.</summary>
    public static void ToggleMaximized(IntPtr window)
    {
        if (window == IntPtr.Zero)
        {
            return;
        }
        if (Restore.Remove(window, out var before))
        {
            SetFrame(window, before);
            Round(window, true);
            return;
        }
        Restore[window] = SendRect(window, Cocoa.Frame);
        SetFrame(window, UsableArea(window));
        Round(window, false);
    }

    /// <summary>
    /// A maximized window moved by its title bar: it's no longer maximized (Restore would jump it back), keeping its
    /// size.
    /// </summary>
    public static void Unmaximized(IntPtr window)
    {
        if (Restore.Remove(window))
        {
            Round(window, true);
        }
    }

    // ---- The page's own windows ----

    /// <summary>
    /// window.open: a web view for an empty page (the page's own windows), in a window of its own at the size and place
    /// asked for; nothing (no window) for anything else.
    /// </summary>
    private static IntPtr Create(IntPtr self, IntPtr selector, IntPtr webView, IntPtr configuration, IntPtr action, IntPtr features)
    {
        try
        {
            var url = Text(Send(Send(Send(action, "request"), "URL"), "absoluteString"));
            if (!string.IsNullOrEmpty(url) && url != BlankPage)
            {
                return IntPtr.Zero;
            }
            var frame = FrameFrom(features);
            var cls = Class(BorderlessWindowClass);
            var window = InitWindow(Send(cls == IntPtr.Zero ? Class("NSWindow") : cls, Cocoa.Alloc), frame, DetachedStyle);
            var content = Send(window, Cocoa.ContentView);
            var view = InitWithFrame(Send(Class(WebViewClass), Cocoa.Alloc), SendRect(content, "bounds"), configuration);
            Send(view, "setAutoresizingMask:", (nint)FillParent);
            Send(content, "addSubview:", view);
            Send(view, SetUIDelegate, self);
            Send(view, "setNavigationDelegate:", Send(webView, "navigationDelegate"));
            Zoom(view, _zoom);
            Round(window, true);
            Open.Add(new Opened(window, view));
            Send(window, Cocoa.MakeKeyAndOrderFront, IntPtr.Zero);
            return view;
        }
        catch (Exception e) when (e is EntryPointNotFoundException or DllNotFoundException)
        {
            return IntPtr.Zero;
        }
    }

    /// <summary>
    /// The window window.open asked for, in Cocoa's frame (from the bottom left): its features are from the top left
    /// of the main screen, and a missing one is the main window's.
    /// </summary>
    private static Rect FrameFrom(IntPtr features)
    {
        var main = SendRect(Main, Cocoa.Frame);
        var screenHeight = SendRect(Send(Send(Class(Cocoa.Screen), Cocoa.Screens), Cocoa.ObjectAtIndex, 0), Cocoa.Frame).Height;
        double Feature(string name, double otherwise) => Send(features, name) is var number && number != IntPtr.Zero ? SendDouble(number, "doubleValue") : otherwise;
        var width = Feature(Features.Width, main.Width);
        var height = Feature(Features.Height, main.Height);
        var left = Feature("x", main.X);
        var top = Feature("y", screenHeight - main.Y - main.Height);
        return OnScreen(new Rect(left, screenHeight - top - height, width, height), main);
    }

    /// <summary>How far down from a window's top its title bar is looked for on a screen, in points.</summary>
    /// <summary>
    /// The frame, if its title bar is on one of the screens; else the same size (no bigger than the main window's
    /// screen) over the main window's middle. WebKit on macOS tells the page no true window places (screenX and
    /// screenY are 0 and the screen's height), so a place the page worked out from them may be off every screen.
    /// </summary>
    private static Rect OnScreen(Rect frame, Rect main)
    {
        if (MacPlacement.TitleBarShows(frame))
        {
            return frame;
        }
        var screen = UsableArea(Main);
        var width = Math.Min(frame.Width, screen.Width);
        var height = Math.Min(frame.Height, screen.Height);
        return new Rect(main.X + (main.Width - width) / 2, main.Y + (main.Height - height) / 2, width, height);
    }

    private const string VisibleFrame = "visibleFrame";
    private const string SetUIDelegate = "setUIDelegate:";

    /// <summary>The window's screen (else the main screen) but the Dock and the menu bar.</summary>
    private static Rect UsableArea(IntPtr window)
    {
        var screen = Send(window, "screen");
        return SendRect(screen != IntPtr.Zero ? screen : Send(Class(Cocoa.Screen), "mainScreen"), VisibleFrame);
    }

    /// <summary>window.close() in a window's page (it has given back what it showed): the window goes.</summary>
    private static void Closed(IntPtr self, IntPtr selector, IntPtr webView)
    {
        if (Open.Find(o => o.View == webView) is { } opened)
        {
            Open.Remove(opened);
            Restore.Remove(opened.Window);
            Send(opened.Window, Cocoa.Close);
        }
    }

    /// <summary>
    /// The main window is closing (NSWindowWillCloseNotification): where it is is remembered (MacPlacement), and the
    /// page's windows close too.
    /// </summary>
    private static void MainClosing(IntPtr self, IntPtr selector, IntPtr notification)
    {
        MacPlacement.Save(Main, Restore.TryGetValue(Main, out var before) ? before : null);
        CloseAll();
    }

    /// <summary>The page says what it named the window it opened last: the oldest one not named yet is it.</summary>
    public static void Named(string name)
    {
        if (Open.Find(o => o.Name is null) is { } opened)
        {
            opened.Name = name;
            Report(opened); // its true place: the page's own (screenX) isn't (OnScreen)
        }
    }

    /// <summary>Closes them all, without asking the page: the main window is closing, and the page with it.</summary>
    public static void CloseAll()
    {
        foreach (var opened in Open.ToList())
        {
            Send(opened.Window, Cocoa.Close);
        }
        Open.Clear();
    }

    /// <summary>
    /// What a window's title bar (the page's header) asks for the window window.open named <paramref name="name"/>:
    /// minimize, maximize or restore, move, resize from an edge, come to the front, stay on top or see-through.
    /// </summary>
    public static void Act(string name, string? action, string? edge)
    {
        if (action == WindowActions.Opened)
        {
            Named(name);
            return;
        }
        if (Open.Find(o => o.Name == name) is not { } opened || _onMain is not { } onMain)
        {
            return;
        }
        var window = opened.Window;
        void ReportPlace() => onMain(() => Report(opened));
        switch (action)
        {
            case WindowActions.Minimize:
                Send(window, "miniaturize:", IntPtr.Zero);
                break;
            case WindowActions.Maximize:
                ToggleMaximized(window);
                break;
            case WindowActions.Drag:
                Unmaximized(window);
                MacWindowDrag.BeginMove(window, onMain, ReportPlace);
                break;
            case WindowActions.Resize when edge is not null && !IsMaximized(window):
                MacWindowDrag.BeginResize(window, edge, DetachedMinSize, onMain, ReportPlace);
                break;
            case WindowActions.Focus:
                Send(Send(Class(Cocoa.Application), Cocoa.SharedApplication), "activateIgnoringOtherApps:", true);
                Send(window, Cocoa.MakeKeyAndOrderFront, IntPtr.Zero);
                break;
            case WindowActions.OnTop:
            case WindowActions.NotOnTop:
                Send(window, "setLevel:", action == WindowActions.OnTop ? FloatingLevel : NormalLevel);
                break;
            case WindowActions.Fade:
            case WindowActions.Solid:
                Send(window, "setAlphaValue:", action == WindowActions.Fade ? FadedAlpha : SolidAlpha);
                break;
        }
    }

    /// <summary>Tells the page where a window is now, from the main screen's top left (as window.open's features are).</summary>
    private static void Report(Opened opened)
    {
        if (opened.Name is not { } name || IsMaximized(opened.Window))
        {
            return;
        }
        var frame = SendRect(opened.Window, Cocoa.Frame);
        var screenHeight = SendRect(Send(Send(Class(Cocoa.Screen), Cocoa.Screens), Cocoa.ObjectAtIndex, 0), Cocoa.Frame).Height;
        Placed?.Invoke(name, frame.X, screenHeight - frame.Y - frame.Height, frame.Width, frame.Height);
    }
}
