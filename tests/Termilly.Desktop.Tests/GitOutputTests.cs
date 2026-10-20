namespace Termilly.Desktop.Tests;

/// <summary>Reading git's output for the Git window (GitOutput.cs), from text as git prints it.</summary>
public sealed class GitOutputTests
{
    private const char U = GitOutput.Unit;

    [Fact]
    public void StatusReadsTheBranchAndEachListOfFiles()
    {
        var raw = string.Join('\0',
            "# branch.oid 1234abcd", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 aaa bbb staged.txt",
            "1 .M N... 100644 100644 100644 aaa bbb changed file.txt",
            "2 R. N... 100644 100644 100644 aaa bbb R100 new.txt", "old.txt",
            "u UU N... 100644 100644 100644 100644 aaa bbb ccc both.txt",
            "? notes.md", "");

        var tree = GitOutput.Status("C:/repo", raw);

        Assert.Equal("main", tree.Branch);
        Assert.Equal("origin/main", tree.Upstream);
        Assert.Equal((2, 1), (tree.Ahead, tree.Behind));
        Assert.True(tree.HasCommits);
        Assert.Equal([new GitFile("staged.txt", null, "M"), new GitFile("new.txt", "old.txt", "R")], tree.Staged);
        Assert.Equal([new GitFile("changed file.txt", null, "M")], tree.Unstaged);
        Assert.Equal([new GitFile("both.txt", null, "U")], tree.Conflicted);
        Assert.Equal([new GitFile("notes.md", null, "?")], tree.Untracked);
    }

    [Fact]
    public void StatusKnowsANewRepositoryAndADetachedHead()
    {
        var tree = GitOutput.Status("C:/repo", "# branch.oid (initial)\0# branch.head (detached)\0");

        Assert.False(tree.HasCommits);
        Assert.True(tree.Detached);
        Assert.Null(tree.Branch);
    }

    [Theory]
    [InlineData("HEAD -> refs/heads/main", "HEAD -> main")]
    [InlineData("tag: refs/tags/v1", "tag: v1")]
    [InlineData("refs/tags/v2", "tag: v2")]
    [InlineData("refs/remotes/origin/x", "remote: origin/x")]
    [InlineData("HEAD", "HEAD")]
    public void ShortRefsReadAsTheHistoryShowsThem(string decoration, string shown) =>
        Assert.Equal(shown, GitOutput.ShortRef(decoration));

    [Fact]
    public void LogReadsEachCommit()
    {
        var raw = $"abc123{U}abc{U}p1 p2{U}Ann{U}2026-01-02T03:04:05Z{U}Merge it{U}HEAD -> refs/heads/main, refs/tags/v1{GitOutput.Record}\n";

        var commit = Assert.Single(GitOutput.Log(raw));

        Assert.Equal(["p1", "p2"], commit.Parents);
        Assert.Equal("Merge it", commit.Subject);
        Assert.Equal(["HEAD -> main", "tag: v1"], commit.Refs);
    }

    [Fact]
    public void CommitFilesJoinTheStatusAndLineCounts()
    {
        var nameStatus = "M\0a.txt\0R100\0old.txt\0new.txt\0A\0image.png\0";
        var numstat = "3\t1\ta.txt\0" + "0\t0\t\0old.txt\0new.txt\0" + "-\t-\timage.png\0";

        var files = GitOutput.CommitFiles(nameStatus, numstat);

        Assert.Equal(
            [new GitCommitFile("a.txt", null, "M", 3, 1), new GitCommitFile("new.txt", "old.txt", "R", 0, 0), new GitCommitFile("image.png", null, "A", null, null)],
            files);
    }

    [Fact]
    public void BranchesPutTheCurrentOneFirstAndSkipRemoteHead()
    {
        var raw = string.Join('\n',
            $"refs/remotes/origin/main{U}origin/main{U} {U}abc{U}{U}{U}2026-01-03{U}Third",
            $"refs/remotes/origin/HEAD{U}origin{U} {U}abc{U}{U}{U}2026-01-03{U}Third",
            $"refs/heads/feature{U}feature{U} {U}def{U}origin/feature{U}gone{U}2026-01-02{U}Second",
            $"refs/heads/main{U}main{U}*{U}abc{U}origin/main{U}ahead 2, behind 1{U}2026-01-01{U}First");

        var branches = GitOutput.Branches(raw);

        Assert.Equal(["main", "feature", "origin/main"], branches.Select(b => b.Name));
        Assert.Equal((2, 1), (branches[0].Ahead, branches[0].Behind));
        Assert.True(branches[1].Gone);
        Assert.True(branches[2].Remote);
    }
}
