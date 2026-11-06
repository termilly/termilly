using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Tests;

public class TodoIssuesTests
{
    [Fact]
    public void Each_value_is_its_own_argument_so_nothing_in_it_is_parsed()
    {
        var arguments = TodoIssues.CreateArguments(new FromPage.TodoIssueCreate(
            Title: "Fix --force & \"quotes\"", Body: "line one\nline two", Labels: ["bug", "good first issue"]));

        Assert.Equal(
            ["issue", "create", "--title", "Fix --force & \"quotes\"", "--body", "line one\nline two", "--label", "bug", "--label", "good first issue"],
            arguments);
    }

    [Fact]
    public void An_issue_without_labels_has_no_label_arguments()
    {
        Assert.DoesNotContain("--label", TodoIssues.CreateArguments(new FromPage.TodoIssueCreate(Title: "t")));
    }

    [Theory]
    [InlineData("https://github.com/termilly/termilly/issues/38\n", "https://github.com/termilly/termilly/issues/38", 38)]
    [InlineData("Creating issue in a/b\n\nhttps://github.com/a/b/issues/7\n", "https://github.com/a/b/issues/7", 7)]
    public void The_issue_is_found_in_what_gh_printed(string output, string url, int number)
    {
        Assert.Equal((url, number), TodoIssues.ParseIssue(output));
    }

    [Theory]
    [InlineData("")]
    [InlineData("nothing here\n")]
    public void No_address_means_no_issue(string output)
    {
        Assert.Null(TodoIssues.ParseIssue(output));
    }

    [Theory]
    [InlineData("https://github.com/termilly/termilly.git\n", true)]
    [InlineData("git@github.com:termilly/termilly.git", true)]
    [InlineData("ssh://git@github.com/termilly/termilly", true)]
    [InlineData("https://gitlab.com/a/b.git", false)]
    [InlineData("https://notgithub.com/a/b.git", false)]
    [InlineData("optiplex:Development/termilly", false)]
    public void A_remote_is_on_github_only_when_it_says_so(string remote, bool onGitHub)
    {
        Assert.Equal(onGitHub, TodoIssues.IsGitHubRemote(remote));
    }

    [Fact]
    public void Label_names_are_read_from_gh()
    {
        Assert.Equal(["bug", "feature"], TodoIssues.LabelNames("""[{"name":"bug"},{"name":"feature"}]"""));
    }

    [Fact]
    public void Output_that_is_not_json_gives_no_labels()
    {
        Assert.Empty(TodoIssues.LabelNames("not json"));
    }
}
