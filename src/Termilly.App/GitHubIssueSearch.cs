using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Shared;

namespace Termilly.Desktop;

/// <summary>
/// A page of a repository's issues through GitHub's search: newest first, as GitHub lists them, a page at a time.
/// Not gh issue list: it can't start past the first issues (only fetch more of them each time), and it reads every
/// comment of every issue to count them.
/// </summary>
internal static class GitHubIssueSearch
{
    internal const int PageSize = 50;
    /// <summary>GitHub's search answers no further than its first thousand results.</summary>
    internal const int MostResults = 1000;
    private const string Endpoint = "search/issues";
    private const string IssueQualifier = "is:issue";
    private const string NewestFirst = "sort=created";
    private const string Descending = "order=desc";
    // GitHub search answer names, and the page list's.
    private const string TotalCount = "total_count";
    private const string Items = "items";
    private const string CreatedField = "created_at";
    private const string UpdatedField = "updated_at";
    private const string WebAddress = "html_url";
    private const string Total = "total";
    private const string More = "more";
    private const string Issues = "issues";
    /// <summary>Search words that would widen or change what's searched: the list is this repository's issues.</summary>
    private static readonly string[] ScopeQualifiers = ["repo:", "org:", "user:", "is:", "type:", "state:"];

    internal static IReadOnlyList<string> Arguments(string repo, string state, string? search, int page)
    {
        if (!GitHubIssueStates.Values.Contains(state))
        {
            throw new ArgumentException("Unknown issue state.");
        }
        if (page < 1 || (page - 1) * PageSize >= MostResults)
        {
            throw new ArgumentException("There is no such page of issues.");
        }
        var stateWord = state == GitHubIssueStates.All ? "" : $"is:{state}";
        var query = string.Join(' ', new[] { $"repo:{repo}", IssueQualifier, stateWord, SearchWords(search) }.Where(s => s.Length > 0));
        return [GitHubWords.Api, GitHubWords.Method, GitHubWords.Get, Endpoint, GitHubWords.Field, $"q={query}",
            GitHubWords.Field, NewestFirst, GitHubWords.Field, Descending,
            GitHubWords.Field, $"per_page={PageSize.ToString(CultureInfo.InvariantCulture)}",
            GitHubWords.Field, $"page={page.ToString(CultureInfo.InvariantCulture)}"];
    }

    /// <summary>The user's search words, without those that would search elsewhere; "#12" looks for 12.</summary>
    internal static string SearchWords(string? search) => string.Join(' ', (search ?? "")
        .Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries)
        .Where(word => !ScopeQualifiers.Any(q => word.TrimStart('-').StartsWith(q, StringComparison.OrdinalIgnoreCase)))
        .Select(word => word.Length > 1 && word[0] == '#' && word.Skip(1).All(char.IsAsciiDigit) ? word[1..] : word));

    /// <summary>GitHub's answer as the page's list: how many there are, whether another page follows, and the rows.</summary>
    internal static JsonObject Parse(string json, int page)
    {
        var answer = JsonNode.Parse(json) as JsonObject ?? throw new JsonException("GitHub returned no issues.");
        var total = answer[TotalCount].AsInt() ?? throw new JsonException("GitHub returned no issue count.");
        var items = answer[Items] as JsonArray ?? throw new JsonException("GitHub returned no issues.");
        var more = items.Count == PageSize && page * PageSize < Math.Min(total, MostResults);
        return new JsonObject
        {
            [Total] = total,
            [More] = more,
            [Issues] = new JsonArray([.. items.Select(Row)]),
        };
    }

    /// <summary>One issue as the list shows it: the same names gh uses elsewhere, the author's login flattened.</summary>
    private static JsonObject Row(JsonNode? item)
    {
        if (item is not JsonObject issue)
        {
            throw new JsonException("GitHub returned an invalid issue.");
        }
        return new JsonObject
        {
            [GitHubWords.Number] = issue[GitHubWords.Number].AsInt() ?? throw new JsonException("GitHub returned an issue without a number."),
            [GitHubWords.TitleField] = issue[GitHubWords.TitleField].AsText() ?? "",
            [GitHubWords.State] = (issue[GitHubWords.State].AsText() ?? throw new JsonException("GitHub returned no issue state.")).ToLowerInvariant(),
            [GitHubWords.Labels] = new JsonArray([.. (issue[GitHubWords.Labels] as JsonArray ?? []).Select(Label)]),
            [GitHubWords.Author] = issue[GitHubWords.User]?[GitHubWords.Login].AsText() ?? "",
            [GitHubWords.CreatedAt] = issue[CreatedField].AsText() ?? "",
            [GitHubWords.UpdatedAt] = issue[UpdatedField].AsText() ?? "",
            [GitHubWords.Comments] = issue[GitHubWords.Comments].AsInt() ?? 0,
            [GitHubWords.Url] = issue[WebAddress].AsText() ?? "",
        };
    }

    private static JsonObject Label(JsonNode? label) => new()
    {
        [GitHubWords.Name] = label?[GitHubWords.Name].AsText() ?? "",
        [GitHubWords.Color] = label?[GitHubWords.Color].AsText(),
    };
}
