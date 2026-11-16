using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using Termilly.Shared;

namespace Termilly.Desktop;

internal static class GitHubUnavailable
{
    public const string Missing = "missing";
    public const string SignedOut = "signedOut";
    public const string NotGitHub = "notGitHub";
    public static readonly string[] All = [Missing, SignedOut, NotGitHub];
}

internal static class GitHubIssueStates
{
    public const string Open = "open";
    public const string Closed = "closed";
    public const string All = "all";
    public static readonly string[] Values = [Open, Closed, All];
}

internal static class GitHubIssueActions
{
    public const string Comment = "comment";
    public const string Close = "close";
    public const string Reopen = "reopen";
    public static readonly string[] All = [Comment, Close, Reopen];
}

internal sealed record GitHubAvailability(bool Available, string? Reason = null, string? Repo = null,
    string? DefaultBranch = null, bool? IsPublic = null, string? Login = null);
internal sealed record GitHubPullRequest(int Number, string Url, string State);
internal sealed record GitHubCreatedPr(int Number, string Url);

internal interface IGitHub
{
    GitHubAvailability Status(string root);
    JsonNode Issues(string root, string state, string? search);
    JsonNode Issue(string root, int number);
    void IssueAct(string root, int number, string? action, string? body);
    GitHubPullRequest? PrFor(string root, string? branch);
    GitHubCreatedPr PrCreate(string root, FromPage.GitHubPrCreate message);
}

internal sealed class GitHub(IProcessRunner runner, LocalGitRunner git) : IGitHub
{
    internal const string Program = "gh";
    private const string IssueFields = "number,title,state,labels,author,updatedAt,comments,url";
    private const string DetailFields = "number,title,state,body,labels,author,createdAt,url,comments";
    private const string PrFields = "number,url,state";
    private const int MaxIssues = 100;
    private static readonly TimeSpan ReadTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan CreateTimeout = TimeSpan.FromSeconds(60);

    public GitHubAvailability Status(string root)
    {
        root = git.CheckRoot(root);
        try
        {
            if (!Run(root, [GitHubWords.Auth, GitHubWords.Status, GitHubWords.Hostname, GitHubWords.Host]).Succeeded)
            {
                return new(false, GitHubUnavailable.SignedOut);
            }
            var origin = GitView.Text(git, root, GitCommands.Remote, GitCommands.Options.GetUrl, GitCommands.Origin);
            if (!GitHubOutput.IsGitHubRemote(origin))
            {
                return new(false, GitHubUnavailable.NotGitHub);
            }
            var repo = Parse(Checked(root, [GitHubWords.Repo, GitHubWords.View, GitHubWords.Json, "nameWithOwner,defaultBranchRef,isPrivate"]))!;
            var login = Checked(root, [GitHubWords.Api, GitHubWords.User, GitHubWords.Hostname, GitHubWords.Host, GitHubWords.Jq, ".login"]).Trim();
            return new(true, Repo: repo[GitHubWords.RepoName].AsText()!,
                DefaultBranch: repo[GitHubWords.DefaultBranch]?[GitHubWords.Name].AsText(),
                IsPublic: !repo[GitHubWords.Private].AsBool()!.Value, Login: login);
        }
        catch (ProgramMissingException e) when (e.Program == Program)
        {
            return new(false, GitHubUnavailable.Missing);
        }
        catch (GitFailedException)
        {
            return new(false, GitHubUnavailable.NotGitHub);
        }
    }

    public JsonNode Issues(string root, string state, string? search) =>
        ParseIssues(Checked(git.CheckRoot(root), IssuesArguments(state, search)));

    public JsonNode Issue(string root, int number) =>
        ParseIssue(Checked(git.CheckRoot(root), [GitHubWords.Issue, GitHubWords.View, Number(number), GitHubWords.Json, DetailFields]));

    public void IssueAct(string root, int number, string? action, string? body) =>
        Checked(git.CheckRoot(root), IssueActArguments(number, action, body));

    public GitHubPullRequest? PrFor(string root, string? branch)
    {
        var json = Parse(Checked(git.CheckRoot(root), [GitHubWords.Pr, GitHubWords.List, GitHubWords.Head, Required(branch), GitHubWords.StateFlag, GitHubIssueStates.All, GitHubWords.Json, PrFields]));
        return json!.AsArray().FirstOrDefault() is { } pr ? PullRequest(pr) : null;
    }

    public GitHubCreatedPr PrCreate(string root, FromPage.GitHubPrCreate message)
    {
        var output = Checked(git.CheckRoot(root), PrCreateArguments(message), CreateTimeout);
        var pr = GitHubOutput.ParseAddress(output, pullRequest: true)
            ?? throw new IOException("GitHub did not return a pull request address.");
        return new(pr.Number, pr.Url);
    }

    internal static IReadOnlyList<string> IssuesArguments(string state, string? search)
    {
        if (!GitHubIssueStates.Values.Contains(state))
        {
            throw new ArgumentException("Unknown issue state.");
        }
        var query = string.IsNullOrWhiteSpace(search) ? "sort:updated-desc" : search + " sort:updated-desc";
        return [GitHubWords.Issue, GitHubWords.List, GitHubWords.StateFlag, state, GitHubWords.Limit, MaxIssues.ToString(CultureInfo.InvariantCulture), GitHubWords.Search, query, GitHubWords.Json, IssueFields];
    }

    internal static IReadOnlyList<string> IssueActArguments(int number, string? action, string? body)
    {
        if (!GitHubIssueActions.All.Contains(action))
        {
            throw new ArgumentException("Unknown issue action.");
        }
        return action == GitHubIssueActions.Comment
            ? [GitHubWords.Issue, action, Number(number), GitHubWords.Body, Required(body)] : [GitHubWords.Issue, action!, Number(number)];
    }

    internal static IReadOnlyList<string> PrCreateArguments(FromPage.GitHubPrCreate message)
    {
        var args = new List<string> { GitHubWords.Pr, GitHubWords.Create, GitHubWords.Base, Required(message.Base), GitHubWords.Head, Required(message.Head),
            GitHubWords.Title, Required(message.Title), GitHubWords.Body, message.Body ?? "" };
        if (message.Draft)
        {
            args.Add(GitHubWords.Draft);
        }
        return args;
    }

    internal static JsonNode ParseIssues(string json)
    {
        var issues = Parse(json)!.AsArray();
        foreach (var issue in issues)
        {
            NormalizeIssue(issue!, false);
        }
        return issues;
    }

    internal static JsonNode ParseIssue(string json)
    {
        var issue = Parse(json)!;
        NormalizeIssue(issue, true);
        return issue;
    }

    private static void NormalizeIssue(JsonNode? issue, bool detail)
    {
        if (issue is not JsonObject)
        {
            throw new JsonException("GitHub returned an invalid issue.");
        }
        foreach (var label in issue[GitHubWords.Labels]?.AsArray() ?? [])
        {
            KeepFields(label, [GitHubWords.Name, GitHubWords.Color]);
        }
        issue[GitHubWords.Author] = issue[GitHubWords.Author]?[GitHubWords.Login].AsText() ?? "";
        issue[GitHubWords.State] = (issue[GitHubWords.State].AsText() ?? throw new JsonException("GitHub returned no issue state.")).ToLowerInvariant();
        if (detail)
        {
            foreach (var comment in Comments(issue))
            {
                KeepFields(comment, [GitHubWords.Author, GitHubWords.BodyField, GitHubWords.CreatedAt]);
                comment![GitHubWords.Author] = comment[GitHubWords.Author]?[GitHubWords.Login].AsText() ?? "";
            }
        }
        else
        {
            issue[GitHubWords.Comments] = Comments(issue).Count;
        }
    }

    private static JsonArray Comments(JsonNode issue) => issue[GitHubWords.Comments] as JsonArray
        ?? throw new JsonException("GitHub returned invalid comments.");

    private static void KeepFields(JsonNode? node, IReadOnlyList<string> fields)
    {
        if (node is not JsonObject value)
        {
            throw new JsonException("GitHub returned invalid data.");
        }
        foreach (var key in value.Select(pair => pair.Key).Where(key => !fields.Contains(key)).ToList())
        {
            value.Remove(key);
        }
    }

    private static JsonNode Parse(string json) => JsonNode.Parse(json) ?? throw new JsonException("GitHub returned no data.");
    private static GitHubPullRequest PullRequest(JsonNode pr) => new(pr[GitHubWords.Number].AsInt()!.Value, pr[GitHubWords.Url].AsText()!, pr[GitHubWords.State].AsText()!);
    private static string Required(string? value) => !string.IsNullOrWhiteSpace(value) ? value : throw new ArgumentException("A required value is empty.");
    private static string Number(int number) => number > 0 ? number.ToString(CultureInfo.InvariantCulture) : throw new ArgumentException("Invalid issue number.");

    private ProcessResult Run(string root, IReadOnlyList<string> args, TimeSpan? timeout = null) =>
        runner.Run(new ProcessRequest(Program, args) { WorkingDirectory = root, Timeout = timeout ?? ReadTimeout });

    private string Checked(string root, IReadOnlyList<string> args, TimeSpan? timeout = null)
    {
        var origin = GitView.Text(git, root, GitCommands.Remote, GitCommands.Options.GetUrl, GitCommands.Origin).Trim();
        if (!GitHubOutput.IsGitHubRemote(origin))
        {
            throw new ArgumentException("This repository's origin is not on GitHub.");
        }
        var result = runner.Run(new ProcessRequest(Program, args)
        {
            WorkingDirectory = root, Timeout = timeout ?? ReadTimeout,
            Environment = new Dictionary<string, string> { ["GH_REPO"] = origin, ["GH_PROMPT_DISABLED"] = "1" },
        });
        if (!result.Succeeded)
        {
            var detail = (result.Error + result.Text).Trim();
            throw new IOException(detail.Length > 0 ? detail : $"GitHub CLI failed ({result.ExitCode}).");
        }
        return result.Text;
    }
}
