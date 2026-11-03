namespace Termilly.Desktop.Messaging;

// The window and the page's life: the title bar, start-up, notifications, links, folders and dialogs.

/// <summary>What the page's title bar asks the window to do (the "window" message's action).</summary>
internal static class WindowActions
{
    public const string Minimize = "minimize";
    public const string Maximize = "maximize";
    public const string Close = "close";
    /// <summary>Quit Termilly, whatever Close does (the palette's "Quit Termilly").</summary>
    public const string Quit = "quit";
    public const string Drag = "drag";
    public const string Resize = "resize";
    /// <summary>One of the page's own windows (js/windows.js) to the front: the message's name says which.</summary>
    public const string Focus = "focus";
    /// <summary>
    /// A detached window see-through while it's dragged over a place it would land (the page sees there), so that place
    /// shows under it.
    /// </summary>
    public const string Fade = "fade";
    /// <summary>A detached window solid again.</summary>
    public const string Solid = "solid";
    /// <summary>
    /// A terminal torn off the main window by its title bar (the pointer left the window while dragging it): its new
    /// window goes under the pointer, grows to the message's size and moves with the pointer until it's let go.
    /// </summary>
    public const string TearOff = "tearOff";
}

/// <summary>
/// The page's own windows (js/windows.js): window.open names them with this prefix, and the hosts give a window of its
/// own (DetachedWindow on Windows, DetachedWindows on Linux) only to a window.open so named.
/// </summary>
internal static class DetachedWindowNames
{
    public const string NamePrefix = "termilly-";
}

/// <summary>The page's answer when the host asks whether it may quit (QuitGate): quit, stay, or it's asking the user.</summary>
internal static class QuitAnswers
{
    public const string Quit = "quit";
    public const string Stay = "stay";
    public const string Asking = "asking";
}

/// <summary>The edge or corner a resize drags (the "window" message's edge): compass points.</summary>
internal static class ResizeEdges
{
    public const string North = "n";
    public const string South = "s";
    public const string East = "e";
    public const string West = "w";
    public const string NorthWest = "nw";
    public const string NorthEast = "ne";
    public const string SouthWest = "sw";
    public const string SouthEast = "se";
}

internal static partial class FromPage
{
    /// <param name="Action">One of <see cref="WindowActions"/>.</param>
    /// <param name="Edge">For a resize, which edge or corner is dragged (one of <see cref="ResizeEdges"/>).</param>
    /// <param name="Name">
    /// A detached window's name (window.open's target, js/windows.js): the action is that window's (its title bar is the
    /// page's), not the main window's. Focus always names one.
    /// </param>
    /// <param name="Width">For a tear-off, the size its window grows to (its page's, in the page's pixels).</param>
    /// <param name="Height">For a tear-off, the size its window grows to.</param>
    internal sealed record Window(string? Action = null, string? Edge = null, string? Name = null, double? Width = null,
        double? Height = null) : IPageMessage
    {
        public static string Type => "window";
    }

    /// <summary>
    /// A picture of the page as it is now, for the outline of a terminal dragged out into a window of its own (it shows
    /// the terminal, js/panes.js). Answered with <see cref="ToPage.WindowCaptured"/>.
    /// </summary>
    internal sealed record WindowCapture(string? RequestId = null) : IPageMessage
    {
        public static string Type => "window:capture";
    }

    /// <summary>The page is up: its first terminal is on screen.</summary>
    internal sealed record Ready : IPageMessage
    {
        public static string Type => "ready";
    }

    /// <summary>An error in the page, for the host's log (Linux: WebKitGTK has no remote DevTools).</summary>
    internal sealed record PageError(string? Message = null, string? Where = null) : IPageMessage
    {
        public static string Type => "page:error";
    }

    /// <summary>Whether Termilly may quit (<see cref="QuitAnswers"/>), after the host asked with quit:ask.</summary>
    internal sealed record QuitAnswer(string? Answer = null) : IPageMessage
    {
        public static string Type => "quit:answer";
    }

    internal sealed record Notify(string Id = "", string? Title = null, string? Body = null) : IPageMessage
    {
        public static string Type => "notify";
    }

    internal sealed record NotifyWithdraw(string Id = "") : IPageMessage
    {
        public static string Type => "notify:withdraw";
    }

    /// <summary>How many terminals need the user, for the taskbar or dock.</summary>
    internal sealed record Badge(int Count = 0) : IPageMessage
    {
        public static string Type => "badge";
    }

    internal sealed record OpenUrl(string? Url = null) : IPageMessage
    {
        public static string Type => "open:url";
    }

    /// <summary>A file or folder to show in the file manager.</summary>
    internal sealed record OpenPath(string? Path = null) : IPageMessage
    {
        public static string Type => "open:path";
    }

    /// <summary>A web page on this machine (an .html file) to open in the default browser.</summary>
    internal sealed record OpenPage(string? Path = null) : IPageMessage
    {
        public static string Type => "open:page";
    }

    internal sealed record DataDirOpen : IPageMessage
    {
        public static string Type => "dataDir:open";
    }

    internal sealed record PickFolder(string? RequestId = null, string? Initial = null) : IPageMessage
    {
        public static string Type => "dialog:pickFolder";
    }

    internal sealed record MemoryMeasure : IPageMessage
    {
        public static string Type => "memory:measure";
    }
}

internal static partial class ToPage
{
    /// <summary>
    /// The window's state: maximized (the title bar's button), minimized, and whether it's the active window. A
    /// minimized WebView can still report document.hasFocus(), so notifications go by this instead (js/store.js isInView).
    /// </summary>
    internal sealed record WindowState(bool Maximized, bool Minimized, bool Active) : IHostMessage
    {
        public static string Type => "windowState";
    }

    /// <summary>
    /// A detached window (<see cref="Name"/>) moved by its title bar: where the pointer is over the main window's page
    /// (X and Y in its pixels; null when it isn't over it), and whether the window was just let go there. The page shows
    /// where a terminal would land, and puts it there when it's let go (js/panes.js).
    /// </summary>
    internal sealed record WindowDragged(string Name, double? X, double? Y, bool Dropped) : IHostMessage
    {
        public static string Type => "window:dragged";
    }

    /// <summary>
    /// A detached window (<see cref="Name"/>) moved or resized, not maximized or minimized: its page's place on the screen
    /// and size, in the page's pixels (as window.open takes them), so it opens there again (js/windows.js).
    /// </summary>
    internal sealed record WindowPlaced(string Name, double X, double Y, double W, double H) : IHostMessage
    {
        public static string Type => "window:placed";
    }

    /// <summary>The page's picture (a JPEG, base64, at the screen's pixels); null where the system can't take one.</summary>
    internal sealed record WindowCaptured(string? RequestId, string? Image) : IHostMessage
    {
        public static string Type => "window:captured";
    }

    /// <summary>A notification was clicked: that terminal comes forward.</summary>
    internal sealed record FocusTerminal(string Id) : IHostMessage
    {
        public static string Type => "focusTerminal";
    }

    /// <summary>The user wants to quit: may Termilly, or is something still running that the page should ask about?</summary>
    internal sealed record QuitAsk : IHostMessage
    {
        public static string Type => "quit:ask";
    }

    /// <summary>The jump hotkey: the next terminal that needs the user.</summary>
    internal sealed record AgentsNext : IHostMessage
    {
        public static string Type => "agents:next";
    }

    /// <summary>Another program has this global shortcut.</summary>
    internal sealed record HotkeyTaken(string Chord) : IHostMessage
    {
        public static string Type => "hotkey:taken";
    }

    internal sealed record FolderPicked(string? RequestId, string? Path) : IHostMessage
    {
        public static string Type => "folderPicked";
    }

    /// <summary>The window is closing: the page sends a last snapshot of its terminals.</summary>
    internal sealed record SnapshotRequest : IHostMessage
    {
        public static string Type => "snapshot:request";
    }

    /// <summary>Memory in use, in bytes: each terminal's processes, the app and its browser engine.</summary>
    internal sealed record Memory(IReadOnlyDictionary<string, long> Sessions, long App, long WebView) : IHostMessage
    {
        public static string Type => "memory";
    }
}
