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
    public void Issue_queries_are_bounded_and_sorted()
    {
        Assert.Equal(["issue", "list", "--state", "all", "--limit", "100", "--search", "bug sort:updated-desc", "--json",
            "number,title,state,labels,author,updatedAt,comments,url"], GitHub.IssuesArguments("all", "bug"));
        Assert.Throws<ArgumentException>(() => GitHub.IssuesArguments("invalid", null));
        Assert.Throws<ArgumentException>(() => GitHub.IssueActArguments(1, "delete", null));
        Assert.Throws<ArgumentException>(() => GitHub.IssueActArguments(0, "close", null));
    }

    [Fact]
    public void Lists_flatten_authors_and_count_comments()
    {
        var issues = GitHub.ParseIssues("""[{"number":7,"title":"Fix","state":"OPEN","author":{"login":"a"},"labels":[{"name":"bug","color":"ff0000"}],"comments":[{},{}],"updatedAt":"today","url":"https://github.com/a/b/issues/7"}]""");
        Assert.Equal("a", issues[0]!["author"].AsText());
        Assert.Equal("open", issues[0]!["state"].AsText());
        Assert.Equal(2, issues[0]!["comments"].AsInt());
    }

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
