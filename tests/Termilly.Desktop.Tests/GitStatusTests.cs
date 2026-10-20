using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class GitStatusTests
{
    [Fact]
    public void Porcelain_v2_gives_branch_changes_and_ahead_behind()
    {
        const string output = "# branch.oid 1a2b3c4d\n# branch.head issue/37-git-ports\n# branch.upstream origin/issue/37-git-ports\n# branch.ab +2 -1\n"
            + "1 .M N... 100644 100644 100644 aaa bbb src/a.ts\n2 R. N... 100644 100644 100644 ccc ddd R100 b.ts\tc.ts\n? new.txt\n";

        var s = GitStatus.Parse(@"D:\repo", output, "1a2b3c4 Add ports");

        Assert.Equal(new GitState(@"D:\repo", "issue/37-git-ports", false, 3, 2, 1, "origin/issue/37-git-ports", "1a2b3c4 Add ports"), s);
    }

    [Fact]
    public void A_detached_head_and_a_clean_tree()
    {
        var s = GitStatus.Parse("/r", "# branch.oid abc\n# branch.head (detached)\n", null);

        Assert.True(s.Detached);
        Assert.Null(s.Branch);
        Assert.Equal((0, 0, 0), (s.Changed, s.Ahead, s.Behind));
    }

    [Fact]
    public void The_repository_root_is_where_dot_git_is()
    {
        var root = Path.Combine(Path.GetTempPath(), $"termilly-git-{Guid.NewGuid():N}");
        Directory.CreateDirectory(Path.Combine(root, ".git"));
        Directory.CreateDirectory(Path.Combine(root, "src", "deep"));
        try
        {
            Assert.Equal(root, GitStatus.RootOf(Path.Combine(root, "src", "deep")));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }
}
