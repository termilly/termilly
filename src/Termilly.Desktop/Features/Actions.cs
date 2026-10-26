using System.IO;
using System.Text;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Runs the actions in Settings › Actions (Actions.cs) when the page asks: fills in what the terminal knows, asks Git
/// for the repository's web page and branch when the action uses them, then opens the page or starts the program.
/// </summary>
internal sealed class ActionHandler(PageChannel page, ISettingsStore settings, IDesktopShell desktop, LocalGitRunner git) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.ActionRun>(m => Task.Run(() => Run(m)));
        router.On<FromPage.ActionDefaults>(_ => page.Post(new ToPage.ActionDefaults(Actions.Defaults)));
    }

    private void Run(FromPage.ActionRun message)
    {
        if (settings.Current.Commands.Actions?.FirstOrDefault(a => a.Id == message.Id && a.Enabled) is not { } action)
        {
            return;
        }
        try
        {
            var used = Actions.PlaceholdersIn(action);
            var needsGit = used.Contains(ActionPlaceholders.Repo) || used.Contains(ActionPlaceholders.Branch);
            var (repo, branch) = needsGit ? RepoOf(message.Folder) : (null, null);
            var launch = Actions.Prepare(action, Actions.Values(new ActionContext(message.Selection, message.Folder, message.Port), repo, branch));
            if (launch.Url is { } url)
            {
                desktop.OpenUrl(url);
            }
            else if (launch.Program is { } program)
            {
                ProgramLauncher.Start(program, launch.Arguments ?? [], launch.Folder);
            }
        }
        catch (ActionUnavailableException e)
        {
            page.Post(new ToPage.ActionFailed(action.Name, e.Message));
        }
    }

    /// <summary>The web page of the folder's origin remote, and the branch checked out; null for what isn't there.</summary>
    private (string? Repo, string? Branch) RepoOf(string? folder)
    {
        if (GitStatus.RootOf(folder) is not { } root)
        {
            return (null, null);
        }
        return (Actions.WebPageOfRemote(GitLine(root, [GitCommands.Remote, GitCommands.Options.GetUrl, GitCommands.Origin])),
            GitLine(root, [GitCommands.Branch, GitCommands.Options.ShowCurrent]));
    }

    private string? GitLine(string root, IReadOnlyList<string> args)
    {
        try
        {
            return Encoding.UTF8.GetString(git.Run(root, args)).Trim() is { Length: > 0 } line ? line : null;
        }
        catch (Exception e) when (e is IOException or ProcessTimeoutException)
        {
            return null; // no such remote, or git missing: the action says what it needed
        }
    }
}
