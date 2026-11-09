namespace Termilly.Desktop.Messaging;

// A terminal's earlier output (EarlierOutput.cs, js/earlier.js): the lines that left its scrollback, kept so search
// still finds them.

internal static partial class FromPage
{
    /// <summary>Lines that left a terminal's scrollback (scrolled past the limit, or wiped), oldest first.</summary>
    internal sealed record EarlierAdd(string Id = "", string[]? Lines = null) : IPageMessage
    {
        public static string Type => "earlier:add";
    }

    /// <summary>Which terminals' earlier output has the text (answered with earlier:found).</summary>
    internal sealed record EarlierSearch(string? RequestId = null, string? Query = null) : IPageMessage
    {
        public static string Type => "earlier:search";
    }

    /// <summary>The last lines of a terminal's earlier output (answered with earlier:tail).</summary>
    internal sealed record EarlierTail(string? RequestId = null, string Id = "", int Count = 0) : IPageMessage
    {
        public static string Type => "earlier:tail";
    }

    /// <summary>A reopened terminal (To) takes its closed self's earlier output (From).</summary>
    internal sealed record EarlierMove(string From = "", string To = "") : IPageMessage
    {
        public static string Type => "earlier:move";
    }

    /// <summary>A terminal whose output isn't kept closed: its earlier output goes.</summary>
    internal sealed record EarlierDelete(string Id = "") : IPageMessage
    {
        public static string Type => "earlier:delete";
    }

    /// <summary>
    /// The open terminals (at start, and after history is cleared): earlier output that's neither theirs nor a closed
    /// terminal's still in history goes, as do chunks past the history setting.
    /// </summary>
    internal sealed record EarlierKeep(string[]? Ids = null) : IPageMessage
    {
        public static string Type => "earlier:keep";
    }
}

internal static partial class ToPage
{
    /// <summary>Earlier output with the searched text: per terminal, the lines around its matches and how many matched.</summary>
    internal sealed record EarlierFound(string? RequestId, IReadOnlyList<EarlierHit> Hits) : IHostMessage
    {
        public static string Type => "earlier:found";
    }

    /// <summary>The last lines of a terminal's earlier output.</summary>
    internal sealed record EarlierTailLines(string? RequestId, IReadOnlyList<string> Lines) : IHostMessage
    {
        public static string Type => "earlier:tail";
    }
}
