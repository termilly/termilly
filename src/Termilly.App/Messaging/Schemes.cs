namespace Termilly.Desktop.Messaging;

// Importing other terminals' colour schemes from files or a folder (js/themeimport.js, Features/SchemeFiles.cs).

/// <summary>A scheme file's name, its text, and where it is in the folder picked (for one from a folder).</summary>
internal sealed record SchemeFileText(string Name, string Text, string? Place = null);

internal static partial class FromPage
{
    /// <summary>Scheme files to import, picked in the open dialog; with <see cref="Folder"/>, a folder to read them all from.</summary>
    internal sealed record SchemeOpen(string? RequestId = null, bool Folder = false) : IPageMessage
    {
        public static string Type => "scheme:open";
    }
}

internal static partial class ToPage
{
    /// <summary>
    /// The files read (null when the dialog was cancelled, empty for an empty folder), how many were left out (too big,
    /// unreadable, past the limits), and an error when nothing could be read.
    /// </summary>
    internal sealed record SchemeOpened(string? RequestId, IReadOnlyList<SchemeFileText>? Files = null, int Skipped = 0, string? Error = null) : IHostMessage
    {
        public static string Type => "scheme:opened";
    }
}
