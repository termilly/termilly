namespace Termilly.Desktop.Messaging;

// Importing another terminal's colour scheme from a file (js/themeimport.js, Features/SchemeFiles.cs).

internal static partial class FromPage
{
    /// <summary>A scheme file to import, picked in the open dialog.</summary>
    internal sealed record SchemeOpen(string? RequestId = null) : IPageMessage
    {
        public static string Type => "scheme:open";
    }
}

internal static partial class ToPage
{
    /// <summary>
    /// The picked file's name and text; no name when the dialog was cancelled, an error when it couldn't be read.
    /// </summary>
    internal sealed record SchemeOpened(string? RequestId, string? Name, string? Text = null, string? Error = null) : IHostMessage
    {
        public static string Type => "scheme:opened";
    }
}
