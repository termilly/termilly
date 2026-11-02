namespace Termilly.Desktop.Messaging;

// Other Termilly computers (js/remotepc.js, Features/RemotePcs.cs): paired once by the code their Settings › Phone
// shows, then their workspaces and terminals under Remote, and their terminals opened here live.

internal static partial class FromPage
{
    /// <summary>The page wants the computers and what each shows.</summary>
    internal sealed record PcList : IPageMessage
    {
        public static string Type => "pc:list";
    }

    /// <summary>Pairs with the Termilly at <see cref="Address"/> (host or host:port) with the code its Settings › Phone shows.</summary>
    internal sealed record PcAdd(string? RequestId = null, string Address = "", string Code = "") : IPageMessage
    {
        public static string Type => "pc:add";
    }

    /// <summary>Forgets a computer (it can be paired again).</summary>
    internal sealed record PcRemove(string Id = "") : IPageMessage
    {
        public static string Type => "pc:remove";
    }

    /// <summary>A terminal here (<see cref="Tab"/>) shows the computer's terminal <see cref="Pane"/>, at this size.</summary>
    internal sealed record PcWatch(string Id = "", string Tab = "", string Pane = "", int Cols = 0, int Rows = 0) : IPageMessage
    {
        public static string Type => "pc:watch";
    }

    /// <summary>That terminal here closed: it no longer shows the other computer's.</summary>
    internal sealed record PcUnwatch(string Tab = "") : IPageMessage
    {
        public static string Type => "pc:unwatch";
    }

    /// <summary>Typing in a terminal here that shows another computer's: it goes there.</summary>
    internal sealed record PcInput(string Tab = "", string Data = "") : IPageMessage
    {
        public static string Type => "pc:input";
    }

    /// <summary>A terminal here that shows another computer's changed size: that one takes it.</summary>
    internal sealed record PcSize(string Tab = "", int Cols = 0, int Rows = 0) : IPageMessage
    {
        public static string Type => "pc:size";
    }
}

internal static partial class ToPage
{
    /// <summary>The paired computers: online or not, and what each shows (its workspaces and terminals, as JSON).</summary>
    internal sealed record Pcs(IReadOnlyList<PcView> Items) : IHostMessage
    {
        public static string Type => "pc:list";
    }

    /// <summary>
    /// The terminal this tab shows has another size there now: that computer took it back (<see cref="By"/> none), or
    /// another phone or computer has it. It's paused here until Resume.
    /// </summary>
    internal sealed record PcPaused(string Tab, string? By = null) : IHostMessage
    {
        public static string Type => "pc:paused";
    }

    /// <summary>How a pairing went: an error, or none.</summary>
    internal sealed record PcAdded(string? RequestId, string? Error) : IHostMessage
    {
        public static string Type => "pc:added";
    }

    /// <summary>What another computer's terminal shows (<see cref="Screen"/>: all of it, drawn anew) or printed since.</summary>
    internal sealed record PcOutput(string Tab, string Data, bool Screen) : IHostMessage
    {
        public static string Type => "pc:output";
    }

    /// <summary>Something sent to another computer's terminal didn't go through (typing is off there, say).</summary>
    internal sealed record PcRefused(string Tab, string Error) : IHostMessage
    {
        public static string Type => "pc:refused";
    }
}

/// <summary>
/// A paired computer as the page shows it: its name and address, whether it's reached now (and why not), and its
/// workspaces and terminals as the phone app gets them (js/phone.js), as JSON.
/// </summary>
internal sealed record PcView(string Id, string Name, string Address, bool Online, string? Error, string? State);
