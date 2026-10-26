namespace Termilly.Desktop.Messaging;

// Settings › Actions: web pages and programs started from Termilly (Actions.cs, js/actions.js).

internal static partial class FromPage
{
    /// <summary>
    /// Runs the action with this id from the settings, with what the page knows about the terminal. The page names an
    /// action rather than sending a program to start, so only what the user set up can run.
    /// </summary>
    internal sealed record ActionRun(string? Id = null, string? Selection = null, string? Folder = null, int? Port = null) : IPageMessage
    {
        public static string Type => "action:run";
    }
}

internal static partial class ToPage
{
    /// <summary>An action couldn't run: what it needed was missing, or its program wasn't found.</summary>
    internal sealed record ActionFailed(string Name, string Message) : IHostMessage
    {
        public static string Type => "action:failed";
    }
}
