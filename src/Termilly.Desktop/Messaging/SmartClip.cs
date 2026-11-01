namespace Termilly.Desktop.Messaging;

// Smart Clip (js/smartclip.js, Features/SmartClip.cs): every copy kept, text and images, to paste any of them later.

internal static partial class FromPage
{
    /// <summary>Termilly copied <see cref="Text"/> (a terminal's selection, a link): where from, and what it is when the page knows.</summary>
    internal sealed record ClipCopied(string Text = "", string Source = "", string? Kind = null) : IPageMessage
    {
        public static string Type => "clip:copied";
    }

    /// <summary>The page wants the clips (it just started).</summary>
    internal sealed record ClipList : IPageMessage
    {
        public static string Type => "clip:list";
    }

    /// <summary>A clip pinned (kept at the top, never dropped) or unpinned.</summary>
    internal sealed record ClipPin(string Id = "", bool Pinned = true) : IPageMessage
    {
        public static string Type => "clip:pin";
    }

    /// <summary>A clip forgotten.</summary>
    internal sealed record ClipForget(string Id = "") : IPageMessage
    {
        public static string Type => "clip:forget";
    }

    /// <summary>Every clip that isn't pinned forgotten.</summary>
    internal sealed record ClipClear : IPageMessage
    {
        public static string Type => "clip:clear";
    }

    /// <summary>
    /// What a clip pastes, <see cref="As"/> one of <see cref="ClipForms"/>: its text, an image's file path, or an image
    /// as a data: URL (to show it, or to put it back on the clipboard).
    /// </summary>
    internal sealed record ClipTake(string? RequestId = null, string Id = "", string As = ClipForms.Text) : IPageMessage
    {
        public static string Type => "clip:take";
    }
}

internal static partial class ToPage
{
    /// <summary>The clips, newest first, and whether copies are kept (Settings › Terminal › Smart Clip).</summary>
    internal sealed record Clips(IReadOnlyList<ClipView> Items, bool Keeping) : IHostMessage
    {
        public static string Type => "clip:clips";
    }

    /// <summary>What a clip pastes (<see cref="FromPage.ClipTake"/>), or why it can't.</summary>
    internal sealed record ClipTaken(string? RequestId, string? Text, string? Error = null) : IHostMessage
    {
        public static string Type => "clip:taken";
    }
}

/// <summary>
/// A clip as the page shows it: a secret's text masked, long text cut short (<see cref="Lines"/> and <see cref="Chars"/>
/// count all of it), an image's size; <see cref="At"/> in Unix milliseconds.
/// </summary>
internal sealed record ClipView(string Id, string Kind, string Text, int Lines, int Chars, string Source, long At, bool Pinned, int Width, int Height, long Bytes);

/// <summary>What a clip is taken as (<see cref="FromPage.ClipTake"/>).</summary>
internal static class ClipForms
{
    public const string Text = "text";
    /// <summary>An image saved as a PNG file, for its path.</summary>
    public const string Path = "path";
    /// <summary>An image as a data: URL.</summary>
    public const string Picture = "picture";
    public static readonly IReadOnlyList<string> All = [Text, Path, Picture];
}
