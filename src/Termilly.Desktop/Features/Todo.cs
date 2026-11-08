using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// To do's one link to GitHub (js/todopanel.js): a task becomes an issue through the GitHub CLI, so Termilly keeps no
/// token of its own. The repository is the one <c>gh</c> finds from the folder's git remote.
/// </summary>
internal sealed partial class TodoIssues(PageChannel page, IProcessRunner runner) : IMessageHandler
{
    private const string Gh = "gh";
    private const string RepoCommand = "repo";
    private const string LabelCommand = "label";
    private const string IssueCommand = "issue";
    private const string View = "view";
    private const string ListVerb = "list";
    private const string CreateVerb = "create";
    private const string JsonFlag = "--json";
    private const string NameField = "name";
    private const string NotInstalled = "The GitHub CLI (gh) isn’t installed, so Termilly can’t create issues.";
    private const string NoFolder = "This list has no folder on this computer.";
    private const int MaxLabels = 200;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.TodoRepoCheck>(RepoCheckAsync);
        router.On<FromPage.TodoIssueInfo>(InfoAsync);
        router.On<FromPage.TodoIssueCreate>(CreateAsync);
    }

    private async Task RepoCheckAsync(FromPage.TodoRepoCheck message)
    {
        var onGitHub = false;
        if (FolderExists(message.Folder))
        {
            try
            {
                var remote = await runner.RunAsync(new ProcessRequest("git", ["remote", "get-url", "origin"]) { WorkingDirectory = message.Folder }).ConfigureAwait(false);
                onGitHub = remote.Succeeded && IsGitHubRemote(remote.Text);
            }
            catch (Exception e) when (e is ProgramMissingException or ProcessTimeoutException)
            {
                onGitHub = false;
            }
        }
        page.Post(new ToPage.TodoRepoChecked(message.Folder, onGitHub));
    }

    /// <summary>Whether a remote's address is on GitHub: https://github.com/a/b.git or git@github.com:a/b.git.</summary>
    internal static bool IsGitHubRemote(string remote) => GitHubRemote().IsMatch(remote.Trim());

    private async Task InfoAsync(FromPage.TodoIssueInfo message)
    {
        if (!FolderExists(message.Folder))
        {
            page.Post(new ToPage.TodoIssueInfo(message.RequestId, null, [], NoFolder));
            return;
        }
        try
        {
            var repo = await RunAsync(message.Folder!, [RepoCommand, View, JsonFlag, "nameWithOwner", "--jq", ".nameWithOwner"]).ConfigureAwait(false);
            if (!repo.Succeeded)
            {
                page.Post(new ToPage.TodoIssueInfo(message.RequestId, null, [], ErrorOf(repo, "This folder isn’t on GitHub.")));
                return;
            }
            var labels = await RunAsync(message.Folder!, [LabelCommand, ListVerb, "--limit", MaxLabels.ToString(Inv), JsonFlag, NameField]).ConfigureAwait(false);
            page.Post(new ToPage.TodoIssueInfo(message.RequestId, repo.Text.Trim(), labels.Succeeded ? LabelNames(labels.Text) : []));
        }
        catch (Exception e) when (e is ProgramMissingException or ProcessTimeoutException)
        {
            page.Post(new ToPage.TodoIssueInfo(message.RequestId, null, [], e is ProgramMissingException ? NotInstalled : e.Message));
        }
    }

    private async Task CreateAsync(FromPage.TodoIssueCreate message)
    {
        if (!FolderExists(message.Folder))
        {
            page.Post(new ToPage.TodoIssueCreated(message.RequestId, null, null, NoFolder));
            return;
        }
        try
        {
            var result = await RunAsync(message.Folder!, CreateArguments(message)).ConfigureAwait(false);
            if (!result.Succeeded || ParseIssue(result.Text) is not { } issue)
            {
                page.Post(new ToPage.TodoIssueCreated(message.RequestId, null, null, ErrorOf(result, "GitHub didn’t create the issue.")));
                return;
            }
            page.Post(new ToPage.TodoIssueCreated(message.RequestId, issue.Url, issue.Number));
        }
        catch (Exception e) when (e is ProgramMissingException or ProcessTimeoutException)
        {
            page.Post(new ToPage.TodoIssueCreated(message.RequestId, null, null, e is ProgramMissingException ? NotInstalled : e.Message));
        }
    }

    /// <summary>What <c>gh</c> is given to create an issue; each value is its own argument, so nothing in it is parsed.</summary>
    internal static IReadOnlyList<string> CreateArguments(FromPage.TodoIssueCreate message)
    {
        var arguments = new List<string> { IssueCommand, CreateVerb, "--title", message.Title, "--body", message.Body };
        foreach (var label in message.Labels ?? [])
        {
            arguments.Add("--label");
            arguments.Add(label);
        }
        return arguments;
    }

    /// <summary>The issue in what <c>gh issue create</c> printed: its address, on the last line that has one.</summary>
    internal static (string Url, int Number)? ParseIssue(string output)
    {
        var match = IssueUrl().Matches(output).LastOrDefault();
        return match is null ? null : (match.Value, int.Parse(match.Groups[1].Value, Inv));
    }

    /// <summary>The names in <c>gh label list --json name</c>; nothing when it isn't what was expected.</summary>
    internal static IReadOnlyList<string> LabelNames(string json)
    {
        try
        {
            return JsonSerializer.Deserialize<List<LabelName>>(json, Options)?.Select(l => l.Name).Where(n => n.Length > 0).ToList() ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static readonly System.Globalization.CultureInfo Inv = System.Globalization.CultureInfo.InvariantCulture;
    private static readonly JsonSerializerOptions Options = new() { PropertyNameCaseInsensitive = true };

    private sealed record LabelName(string Name);

    private static bool FolderExists(string? folder) => !string.IsNullOrEmpty(folder) && Directory.Exists(folder);

    private static string ErrorOf(ProcessResult result, string fallback) => result.FirstErrorLine ?? fallback;

    private Task<ProcessResult> RunAsync(string folder, IReadOnlyList<string> arguments) =>
        runner.RunAsync(new ProcessRequest(Gh, arguments) { WorkingDirectory = folder });

    [GeneratedRegex(@"^(https://|ssh://git@|git@)github\.com[/:]", RegexOptions.IgnoreCase)]
    private static partial Regex GitHubRemote();

    [GeneratedRegex(@"https://\S+/issues/(\d+)")]
    private static partial Regex IssueUrl();
}
