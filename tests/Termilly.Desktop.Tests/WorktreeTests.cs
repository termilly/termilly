using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class WorktreeTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), $"termilly-wt-{Guid.NewGuid():N}");
    private string Repo => Path.Combine(_root, "app");

    public WorktreeTests()
    {
        Directory.CreateDirectory(Path.Combine(Repo, "config"));
        TestServices.Git.Text(Repo, "init", "-q", "-b", "main");
        TestServices.Git.Text(Repo, "config", "user.email", "test@example.com");
        TestServices.Git.Text(Repo, "config", "user.name", "Test");
        File.WriteAllText(Path.Combine(Repo, ".gitignore"), ".env\nconfig/local.json\n");
        File.WriteAllText(Path.Combine(Repo, ".worktreeinclude"), "# secrets the app needs\n.env\nconfig/*.json\n../outside\n");
        File.WriteAllText(Path.Combine(Repo, "readme.md"), "hi");
        TestServices.Git.Text(Repo, "add", ".");
        TestServices.Git.Text(Repo, "commit", "-q", "-m", "first");
        File.WriteAllText(Path.Combine(Repo, ".env"), "KEY=1");
        File.WriteAllText(Path.Combine(Repo, "config", "local.json"), "{}");
    }

    public void Dispose()
    {
        try
        {
            foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
            {
                File.SetAttributes(file, FileAttributes.Normal); // git's object files are read-only
            }
            Directory.Delete(_root, recursive: true);
        }
        catch (IOException)
        {
        }
    }

    [Theory]
    [InlineData("agent/fix login", "agent/fix-login")]
    [InlineData("  feature: new?! ", "feature-new")]
    [InlineData("a..b//c.lock", "a.b/c")]
    public void Typed_names_become_branch_names(string typed, string branch) =>
        Assert.Equal(branch, Worktrees.BranchName(typed));

    [Fact]
    public void Worktrees_go_next_to_the_repository() =>
        Assert.Equal(@"D:\src\app.worktrees\agent-fix", Worktrees.PathFor(@"D:\src\app", "agent/fix"));

    [Fact]
    public void Create_makes_the_branch_and_folder_and_copies_included_files()
    {
        var created = TestServices.Worktrees.Create(Path.Combine(Repo, "config"), "agent/try it");

        Assert.Equal("agent/try-it", created.Branch);
        Assert.Equal(Path.Combine(_root, "app.worktrees", "agent-try-it"), created.Path);
        Assert.Equal(2, created.Copied);
        Assert.Equal("KEY=1", File.ReadAllText(Path.Combine(created.Path, ".env")));
        Assert.True(File.Exists(Path.Combine(created.Path, "config", "local.json")));
        Assert.Equal("agent/try-it", TestServices.Git.Text(created.Path, "rev-parse", "--abbrev-ref", "HEAD"));

        var status = TestServices.Worktrees.Status(created.Repo, created.Path, created.Branch);
        Assert.Equal(("main", true, 0), (status.Base, status.Merged, status.Changes)); // no commits of its own yet

        File.WriteAllText(Path.Combine(created.Path, "work.txt"), "x");
        TestServices.Git.Text(created.Path, "add", ".");
        TestServices.Git.Text(created.Path, "commit", "-q", "-m", "work");
        File.WriteAllText(Path.Combine(created.Path, "more.txt"), "y");
        status = TestServices.Worktrees.Status(created.Repo, created.Path, created.Branch);
        Assert.Equal((false, 1), (status.Merged, status.Changes));

        Assert.Throws<IOException>(() => TestServices.Worktrees.Remove(created.Repo, created.Path, created.Branch, deleteBranch: false, force: false));
        TestServices.Worktrees.Remove(created.Repo, created.Path, created.Branch, deleteBranch: true, force: true);
        Assert.False(Directory.Exists(created.Path));
        Assert.False(Directory.Exists(Path.Combine(_root, "app.worktrees")));
        Assert.DoesNotContain("agent/try-it", TestServices.Git.Text(Repo, "branch", "--format=%(refname:short)"));
    }

    [Fact]
    public void A_folder_outside_a_repository_says_so() =>
        Assert.Throws<IOException>(() => TestServices.Worktrees.Create(_root, "x"));
}
