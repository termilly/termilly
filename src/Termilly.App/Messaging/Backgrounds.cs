namespace Termilly.Desktop.Messaging;

// The window's background (Settings › Appearance › Background, js/settings/appearancebackground.js): a picture picked
// and kept in the app's data folder (Features/BackgroundPictures.cs), and the effects this system's windows have.

internal static partial class FromPage
{
    /// <summary>A picture to show behind the terminals, picked in the open dialog and copied into the backgrounds folder.</summary>
    internal sealed record BackgroundPick(string? RequestId = null) : IPageMessage
    {
        public static string Type => "background:pick";
    }

    /// <summary>The effects the window can have here, and the pictures folder's address for the page.</summary>
    internal sealed record BackgroundInfo(string? RequestId = null) : IPageMessage
    {
        public static string Type => "background:info";
    }
}

internal static partial class ToPage
{
    /// <summary>The picture's name in the backgrounds folder; neither when the dialog was cancelled, an error when it couldn't be kept.</summary>
    internal sealed record BackgroundPicked(string? RequestId, string? Picture = null, string? Error = null) : IHostMessage
    {
        public static string Type => "background:picked";
    }

    /// <summary>
    /// The effects (<see cref="BackgroundValues.Effect"/>) this system's windows have, and where the page loads a
    /// picture from (its name added to <see cref="PictureBase"/>).
    /// </summary>
    internal sealed record BackgroundInfo(string? RequestId, IReadOnlyList<string> Effects, string PictureBase) : IHostMessage
    {
        public static string Type => "background:info";
    }
}
