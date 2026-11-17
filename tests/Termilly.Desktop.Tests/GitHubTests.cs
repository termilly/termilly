using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Shared;

namespace Termilly.Desktop.Tests;

public sealed class GitHubTests
{
    [Fact]
    public void Arguments_keep_user_text_in_single_values()
    {
        const string body = "line one\n' $(echo wrong) & --force";
        Assert.Equal(["issue", "comment", "7", "--body", body], GitHub.IssueActArguments(7, "comment", body));
        var args = GitHub.PrCreateArguments(new FromPage.GitHubPrCreate(Base: "main", Head: "fix", Title: "Fix", Body: body, Draft: true));
        Assert.Equal(["pr", "create", "--base", "main", "--head", "fix", "--title", "Fix", "--body", body, "--draft"], args);
    }

    [Fact]
    public void Issues_are_asked_a_page_at_a_time_newest_first_in_this_repository_only()
    {
        Assert.Equal(["api", "-X", "GET", "search/issues", "-f", "q=repo:a/b is:issue is:open bug label:ui 12", "-f", "sort=created",
            "-f", "order=desc", "-f", "per_page=50", "-f", "page=3"], GitHubIssueSearch.Arguments("a/b", "open", "bug repo:x/y -is:pr label:ui #12", 3));
        Assert.Equal("q=repo:a/b is:issue", GitHubIssueSearch.Arguments("a/b", "all", "  ", 1)[5]);
        Assert.Throws<ArgumentException>(() => GitHubIssueSearch.Arguments("a/b", "invalid", null, 1));
        Assert.Throws<ArgumentException>(() => GitHubIssueSearch.Arguments("a/b", "open", null, 0));
        Assert.Throws<ArgumentException>(() => GitHubIssueSearch.Arguments("a/b", "open", null, 21)); // past GitHub's first thousand
        Assert.Throws<ArgumentException>(() => GitHub.IssueActArguments(1, "delete", null));
        Assert.Throws<ArgumentException>(() => GitHub.IssueActArguments(0, "close", null));
    }

    [Theory]
    [InlineData(50, 120, 1, 3, 1, false)]
    [InlineData(20, 120, 3, 3, 101, false)] // the last page, shorter
    [InlineData(0, 0, 1, 0, 1, false)] // none at all
    [InlineData(50, 100, 2, 2, 51, false)] // pages that come out even
    [InlineData(50, 2196, 20, 20, 951, true)] // GitHub shows no further than a thousand
    public void A_page_says_where_it_starts_and_how_many_pages_there_are(int rows, int total, int page, int pages, int first, bool capped)
    {
        var items = string.Join(",", Enumerable.Range(1, rows).Select(n => $$"""{"number":{{n}},"title":"T","state":"open"}"""));
        var list = GitHubIssueSearch.Parse($$"""{"total_count":{{total}},"items":[{{items}}]}""", page);
        Assert.Equal(total, list["total"].AsInt());
        Assert.Equal(page, list["page"].AsInt());
        Assert.Equal(pages, list["pages"].AsInt());
        Assert.Equal(first, list["first"].AsInt());
        Assert.Equal(capped, list["capped"].AsBool());
        Assert.Equal(rows, list["issues"]!.AsArray().Count);
    }

    [Fact]
    public void Rows_flatten_the_author_and_take_the_list_names()
    {
        var list = GitHubIssueSearch.Parse("""{"total_count":1,"items":[{"number":7,"title":"Fix","state":"OPEN","user":{"login":"a"},"labels":[{"name":"bug","color":"ff0000","id":3}],"comments":2,"created_at":"2026-11-01T10:00:00Z","updated_at":"2026-11-02T10:00:00Z","html_url":"https://github.com/a/b/issues/7","body":"long"}]}""", 1);
        var issue = list["issues"]![0]!;
        Assert.Equal("a", issue["author"].AsText());
        Assert.Equal("open", issue["state"].AsText());
        Assert.Equal(2, issue["comments"].AsInt());
        Assert.Equal("2026-11-01T10:00:00Z", issue["createdAt"].AsText());
        Assert.Equal("https://github.com/a/b/issues/7", issue["url"].AsText());
        Assert.Equal("""[{"name":"bug","color":"ff0000"}]""", issue["labels"]!.ToJsonString());
        Assert.Null(issue["body"]); // the list doesn't carry what only the issue shows
    }

    [Theory]
    [InlineData("https://github.com/openclaw/openclaw.git", "openclaw/openclaw")]
    [InlineData("git@github.com:a/b", "a/b")]
    [InlineData("ssh://git@github.com/a/b.c.git/", "a/b.c")]
    [InlineData("https://gitlab.com/a/b.git", null)]
    public void The_repository_is_read_from_its_origin(string origin, string? repo) => Assert.Equal(repo, GitHubOutput.RepoName(origin));

    [Fact]
    public void Details_flatten_comment_authors_and_allow_deleted_users()
    {
        var issue = GitHub.ParseIssue("""{"number":1,"state":"CLOSED","author":null,"comments":[{"author":{"login":"b"},"body":"Hi","createdAt":"today"}]}""");
        Assert.Equal("", issue["author"].AsText());
        Assert.Equal("closed", issue["state"].AsText());
        Assert.Equal("b", issue["comments"]![0]!["author"].AsText());
    }

    [Theory]
    [InlineData("null")]
    [InlineData("[]")]
    [InlineData("{\"state\":42,\"author\":null}")]
    public void Invalid_issue_data_is_rejected(string json)
    {
        Assert.Throws<JsonException>(() => GitHub.ParseIssue(json));
    }

    [Fact]
    public void Pull_request_address_is_read_from_the_last_matching_line()
    {
        Assert.Equal(new GitHubAddress("https://github.com/a/b/pull/42", 42),
            GitHubOutput.ParseAddress("Creating pull request\nhttps://github.com/a/b/pull/42\n", true));
        Assert.Null(GitHubOutput.ParseAddress("not an address", true));
    }
}
