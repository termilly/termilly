using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// Images shown as pictures (data: URLs) in the Git window and the change preview, beside or instead of their diff:
/// a binary image has no lines to compare.
/// </summary>
internal static class ChangePictures
{
    /// <summary>The images shown as pictures, by extension: what they're sent as.</summary>
    private static readonly Dictionary<string, string> ImageTypes = new(StringComparer.OrdinalIgnoreCase)
    {
        [".png"] = "image/png", [".jpg"] = "image/jpeg", [".jpeg"] = "image/jpeg", [".gif"] = "image/gif",
        [".webp"] = "image/webp", [".bmp"] = "image/bmp", [".ico"] = "image/x-icon", [".avif"] = "image/avif",
        [".svg"] = "image/svg+xml",
    };

    /// <summary>An image's type ("image/png"), or null for a file that isn't one.</summary>
    public static string? TypeOf(string path) => ImageTypes.GetValueOrDefault(Path.GetExtension(path));

    /// <summary>
    /// An image's two versions as pictures: the note that a binary file has no lines to compare goes; an SVG keeps its
    /// text diff too. One over the size limit keeps its note.
    /// </summary>
    public static ChangeView With(ChangeView view, string type, Blob before, Blob after)
    {
        static string? Picture(Blob blob, string type) => blob.Raw is { } raw ? $"data:{type};base64,{Convert.ToBase64String(raw)}" : null;
        var beforeImage = Picture(before, type);
        var afterImage = Picture(after, type);
        var shown = (beforeImage ?? afterImage) is not null && !before.TooLarge && !after.TooLarge;
        return view with { BeforeImage = beforeImage, AfterImage = afterImage, Note = shown && (before.Binary || after.Binary) ? null : view.Note };
    }

    /// <summary>The file as it is, and its last commit's copy only where that differs (an image that didn't change is one picture).</summary>
    public static ChangeView OfFile(ChangeView view, string type, Blob? head, Blob disk) =>
        With(view, type, head is { Raw: { } before } && !(disk.Raw is { } after && before.AsSpan().SequenceEqual(after)) ? head : Blob.Missing, disk);
}
