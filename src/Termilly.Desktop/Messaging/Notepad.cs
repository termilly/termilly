namespace Termilly.Desktop.Messaging;

// The Notepad (js/notepad.js): a page saved to a text file, and a text file opened in a page (Features/Notepad.cs).

internal static partial class FromPage
{
    /// <summary>
    /// Writes a page to <see cref="Path"/>; with no path, or <see cref="Ask"/>, the save dialog asks where first,
    /// offering <see cref="Name"/>.
    /// </summary>
    internal sealed record NotepadSave(string? RequestId = null, string? Path = null, string? Name = null, string Text = "", bool Ask = false) : IPageMessage
    {
        public static string Type => "notepad:save";
    }

    /// <summary>A text file to open in a new page, picked in the open dialog.</summary>
    internal sealed record NotepadOpen(string? RequestId = null) : IPageMessage
    {
        public static string Type => "notepad:open";
    }
}

internal static partial class ToPage
{
    /// <summary>Where the page was saved; no path and no error when the dialog was cancelled.</summary>
    internal sealed record NotepadSaved(string? RequestId, string? Path, string? Error = null) : IHostMessage
    {
        public static string Type => "notepad:saved";
    }

    /// <summary>The file opened and its text; no path and no error when the dialog was cancelled.</summary>
    internal sealed record NotepadOpened(string? RequestId, string? Path, string? Text = null, string? Error = null) : IHostMessage
    {
        public static string Type => "notepad:opened";
    }
}
