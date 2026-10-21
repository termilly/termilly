namespace Termilly.Desktop.Messaging;

// The window and the page's life: the title bar, start-up, notifications, links, folders and dialogs.

/// <summary>What the page's title bar asks the window to do (the "window" message's action).</summary>
internal static class WindowActions
{
    public const string Minimize = "minimize";
    public const string Maximize = "maximize";
    public const string Close = "close";
    public const string Drag = "drag";
    public const string Resize = "resize";
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
    internal sealed record Window(string? Action = null, string? Edge = null) : IPageMessage
    {
        public static string Type => "window";
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

    internal sealed record QuakeLeave : IPageMessage
    {
        public static string Type => "quake:leave";
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

    /// <summary>A notification was clicked: that terminal comes forward.</summary>
    internal sealed record FocusTerminal(string Id) : IHostMessage
    {
        public static string Type => "focusTerminal";
    }

    /// <summary>The drop-down window came down or went up.</summary>
    internal sealed record Quake(bool Down) : IHostMessage
    {
        public static string Type => "quake";
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
