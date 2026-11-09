namespace Termilly.Desktop.Messaging;

// Settings › Actions: web pages and programs started from Termilly (Actions.cs, js/actions.js).

internal static partial class FromPage
{
    /// <summary>
    /// Runs the action with this id from the settings, with what the page knows about the terminal. The page names an
    /// action rather than sending a program to start, so only what the user set up can run. <see cref="Image"/> is an
    /// image file to hand on (a Clipboard image).
    /// </summary>
    internal sealed record ActionRun(string? Id = null, string? Selection = null, string? Folder = null, int? Port = null, string? Image = null) : IPageMessage
    {
        public static string Type => "action:run";
    }

    /// <summary>Settings › Actions › Restore: the actions Termilly starts with, to save in place of the user’s.</summary>
    internal sealed record ActionDefaults : IPageMessage
    {
        public static string Type => "action:defaults";
    }
}

internal static partial class ToPage
{
    /// <summary>An action couldn't run: what it needed was missing, or its program wasn't found.</summary>
    internal sealed record ActionFailed(string Name, string Message) : IHostMessage
    {
        public static string Type => "action:failed";
    }

    internal sealed record ActionDefaults(IReadOnlyList<ActionSetting> Actions) : IHostMessage
    {
        public static string Type => "action:defaults";
    }
}
