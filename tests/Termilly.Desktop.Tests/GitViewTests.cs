using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>The Git window's host side (GitView.cs), against a real repository made in a temp folder.</summary>
public sealed class GitViewTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private const long Max = 1024 * 1024;

    public GitViewTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal); // git makes its objects read-only
        }
        Directory.Delete(_dir, recursive: true);
    }

    private static bool HasGit()
    {
        try
        {
            TestServices.Git.Text(Path.GetTempPath(), "--version");
            return true;
        }
        catch (IOException)
        {
            return false;
        }
    }

    private static string Write(string repo, string name, string text)
    {
        var path = Path.Combine(repo, name);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        return path;
    }

    /// <summary>
    /// Two commits on main (the second tagged v1), a "feature" branch one commit ahead, then: a staged change, the same
    /// file changed again on disk, a staged rename, an untracked file and a deleted file.
    /// </summary>
    private string Repo()
    {
        var repo = Directory.CreateDirectory(Path.Combine(_dir, "repo")).FullName;
        void Git(params string[] args) => TestServices.Git.Text(repo, args);
        Git("init", "-q", "-b", "main");
        Git("config", "user.email", "test@example.com");
        Git("config", "user.name", "Test");
        Git("config", "core.autocrlf", "false");
        Write(repo, "a.txt", "one\ntwo\nthree\n");
        Write(repo, "old name.txt", "renamed file\n");
        Write(repo, "gone.txt", "will be deleted\n");
        Git("add", ".");
        Git("commit", "-q", "-m", "first");
        Write(repo, "src/b.cs", "class B {}\n");
        Git("add", ".");
        Git("commit", "-q", "-m", "second\n\nWith a body.");
        Git("tag", "v1");
        Git("branch", "feature");
        Git("checkout", "-q", "feature");
        Write(repo, "feature.txt", "on the branch\n");
        Git("add", ".");
        Git("commit", "-q", "-m", "feature work");
        Git("checkout", "-q", "main");
        Git("branch", "--set-upstream-to=feature", "main");
        Write(repo, "a.txt", "one\nTWO\nthree\n");
        Git("add", "a.txt");
        Write(repo, "a.txt", "one\nTWO\nthree\nfour\n");
        Git("mv", "old name.txt", "new name.txt");
        Write(repo, "notes/new.md", "untracked\n");
        File.Delete(Path.Combine(repo, "gone.txt"));
        return repo;
    }

    [Fact]
    public void Status_groups_staged_unstaged_and_untracked_files()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var tree = GitView.Status(Path.Combine(repo, "src"), TestServices.GitRunner);
        Assert.Equal(repo, tree.Root);
        Assert.Equal("main", tree.Branch);
        Assert.Equal("feature", tree.Upstream);
        Assert.Equal(1, tree.Behind);
        Assert.Contains(tree.Staged, f => f.Path == "a.txt" && f.Status == "M");
        Assert.Contains(tree.Staged, f => f.Path == "new name.txt" && f.OldPath == "old name.txt" && f.Status == "R");
        Assert.Contains(tree.Unstaged, f => f.Path == "a.txt" && f.Status == "M");
        Assert.Contains(tree.Unstaged, f => f.Path == "gone.txt" && f.Status == "D");
        Assert.Equal(["notes/new.md"], tree.Untracked.Select(f => f.Path));
        Assert.Empty(tree.Conflicted);
    }

    [Fact]
    public void Staged_and_unstaged_diffs_compare_the_right_copies()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var staged = GitView.Diff(repo, new GitDiffTarget("a.txt", null, "staged", null), Max, TestServices.GitRunner);
        Assert.Equal("one\ntwo\nthree\n", staged.Before);
        Assert.Equal("one\nTWO\nthree\n", staged.After);
        Assert.Equal((1, 1), (staged.Added, staged.Removed));
        var unstaged = GitView.Diff(repo, new GitDiffTarget("a.txt", null, "unstaged", null), Max, TestServices.GitRunner);
        Assert.Equal("one\nTWO\nthree\n", unstaged.Before);
        Assert.Equal("one\nTWO\nthree\nfour\n", unstaged.After);
        Assert.Equal((1, 0), (unstaged.Added, unstaged.Removed));
        var renamed = GitView.Diff(repo, new GitDiffTarget("new name.txt", "old name.txt", "staged", null), Max, TestServices.GitRunner);
        Assert.Equal("modified", renamed.Kind);
        Assert.Equal(0, renamed.Added);
        var untracked = GitView.Diff(repo, new GitDiffTarget("notes/new.md", null, "untracked", null), Max, TestServices.GitRunner);
        Assert.Equal("created", untracked.Kind);
        Assert.Equal("deleted", GitView.Diff(repo, new GitDiffTarget("gone.txt", null, "unstaged", null), Max, TestServices.GitRunner).Kind);
    }

    [Fact]
    public void Binary_files_say_so_instead_of_lines()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        File.WriteAllBytes(Path.Combine(repo, "logo.bin"), [0x89, 0x50, 0x00, 0x01, 0x02]);
        var view = GitView.Diff(repo, new GitDiffTarget("logo.bin", null, "untracked", null), Max, TestServices.GitRunner);
        Assert.Null(view.After);
        Assert.Contains("binary", view.Note);
    }

    [Fact]
    public void History_pages_newest_first_with_branches_and_tags()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var all = GitView.Log(repo, 0, 100, null, TestServices.GitRunner);
        Assert.Equal(["second", "first"], all.Select(c => c.Subject));
        Assert.Contains("HEAD -> main", all[0].Refs);
        Assert.Contains("tag: v1", all[0].Refs);
        Assert.Empty(all[1].Parents);
        Assert.Equal(["first"], GitView.Log(repo, 1, 1, null, TestServices.GitRunner).Select(c => c.Subject));
        var feature = GitView.Log(repo, 0, 100, "refs/heads/feature", TestServices.GitRunner);
        Assert.Equal("feature work", feature[0].Subject);
        Assert.Contains("feature", feature[0].Refs);
    }

    // ---- Search ----

    [Fact]
    public void Search_finds_changed_files_by_path_and_by_what_is_in_them()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var four = Assert.Single(GitSearch.Search(repo, "FOUR", TestServices.GitRunner).Files);
        Assert.Equal(("a.txt", "unstaged", 4, "four"), (four.Path, four.Side, four.Line, four.Text));
        var untracked = Assert.Single(GitSearch.Search(repo, "untracked", TestServices.GitRunner).Files);
        Assert.Equal(("notes/new.md", "untracked", "U", 1), (untracked.Path, untracked.Side, untracked.Status, untracked.Line));
        var renamed = Assert.Single(GitSearch.Search(repo, "new name", TestServices.GitRunner).Files);
        Assert.Equal(("new name.txt", "staged", 0), (renamed.Path, renamed.Side, renamed.Line));
        Assert.Equal(["gone.txt"], GitSearch.Search(repo, "gone", TestServices.GitRunner).Files.Select(f => f.Path));
    }

    [Fact]
    public void Search_finds_commits_by_hash_message_and_author_and_branches_and_tags_by_name()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var log = GitView.Log(repo, 0, 10, null, TestServices.GitRunner);
        var body = Assert.Single(GitSearch.Search(repo, "BODY", TestServices.GitRunner).Commits);
        Assert.Equal(("second", "message"), (body.Commit.Subject, body.On));
        var byHash = GitSearch.Search(repo, log[1].Short.ToUpperInvariant(), TestServices.GitRunner).Commits;
        Assert.Equal((log[1].Hash, "hash"), (byHash[0].Commit.Hash, byHash[0].On));
        var byAuthor = GitSearch.Search(repo, "test@example", TestServices.GitRunner).Commits;
        Assert.Equal(2, byAuthor.Count);
        Assert.All(byAuthor, c => Assert.Equal("author", c.On));
        Assert.Contains(GitSearch.Search(repo, "FEAT", TestServices.GitRunner).Branches, b => b.Name == "feature");
        var tag = Assert.Single(GitSearch.Search(repo, "v1", TestServices.GitRunner).Tags);
        Assert.Equal(("v1", log[0].Hash), (tag.Name, tag.Hash));
    }

    [Fact]
    public void Search_finds_the_lines_commits_added_or_removed_a_batch_at_a_time()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var code = GitSearch.SearchCode(repo, "CLASS b", 0, TestServices.GitRunner);
        var hit = Assert.Single(code.Commits);
        Assert.Equal("second", hit.Commit.Subject);
        Assert.Equal([new GitCodeLine("src/b.cs", true, "class B {}")], hit.Lines);
        Assert.Equal((2, false), (code.Searched, code.More));
        Assert.Empty(GitSearch.SearchCode(repo, "class B", 1, TestServices.GitRunner).Commits);
        // What a regular expression reads as more than itself is just text here.
        Assert.Empty(GitSearch.SearchCode(repo, "c.ass [B", 0, TestServices.GitRunner).Commits);
    }

    [Fact]
    public void Search_text_is_never_an_option_and_a_repository_without_commits_still_searches_its_files()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        foreach (var text in new[] { "--output=x", "-e", "--all" })
        {
            var found = GitSearch.Search(repo, text, TestServices.GitRunner);
            Assert.Empty(found.Files);
            Assert.Empty(found.Commits);
            Assert.Empty(GitSearch.SearchCode(repo, text, 0, TestServices.GitRunner).Commits);
        }
        Assert.False(File.Exists(Path.Combine(repo, "x")));
        var empty = Directory.CreateDirectory(Path.Combine(_dir, "empty")).FullName;
        TestServices.Git.Text(empty, "init", "-q", "-b", "main");
        Write(empty, "x.txt", "needle\n");
        Assert.Equal(["x.txt"], GitSearch.Search(empty, "needle", TestServices.GitRunner).Files.Select(f => f.Path));
        Assert.Empty(GitSearch.SearchCode(empty, "needle", 0, TestServices.GitRunner).Commits);
    }

    [Fact]
    public void A_commit_lists_its_message_and_files_and_diffs_against_its_parent()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var second = GitView.Log(repo, 0, 1, null, TestServices.GitRunner)[0];
        var detail = GitView.Commit(repo, second.Hash, TestServices.GitRunner);
        Assert.Equal("second\n\nWith a body.", detail.Message);
        var file = Assert.Single(detail.Files);
        Assert.Equal(("src/b.cs", "A", 1, 0), (file.Path, file.Status, file.Added ?? -1, file.Removed ?? -1));
        var diff = GitView.Diff(repo, new GitDiffTarget("src/b.cs", null, "commit", second.Hash), Max, TestServices.GitRunner);
        Assert.Equal("created", diff.Kind);
        var first = GitView.Log(repo, 1, 1, null, TestServices.GitRunner)[0];
        Assert.Equal(3, GitView.Commit(repo, first.Short, TestServices.GitRunner).Files.Count);
        Assert.Equal("created", GitView.Diff(repo, new GitDiffTarget("a.txt", null, "commit", first.Hash), Max, TestServices.GitRunner).Kind);
    }

    [Fact]
    public void Branches_list_the_current_one_first_with_how_far_apart_they_are()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        var branches = GitView.Branches(repo, TestServices.GitRunner);
        Assert.Equal("main", branches[0].Name);
        Assert.True(branches[0].Current);
        Assert.Equal(1, branches[0].Behind);
        Assert.Contains(branches, b => b.Name == "feature" && !b.Current && b.Subject == "feature work");
    }

    [Fact]
    public void Paths_hashes_and_refs_from_the_page_are_checked()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        foreach (var bad in new[] { "../outside.txt", "C:\\Windows\\win.ini", "/etc/passwd", "a/../../x", "--output=x", "HEAD:a.txt", "" })
        {
            Assert.Throws<ArgumentException>(() => GitView.Diff(repo, new GitDiffTarget(bad, null, "unstaged", null), Max, TestServices.GitRunner));
        }
        Assert.Throws<ArgumentException>(() => GitView.Commit(repo, "--all", TestServices.GitRunner));
        Assert.Throws<ArgumentException>(() => GitView.Diff(repo, new GitDiffTarget("a.txt", null, "commit", "HEAD~1"), Max, TestServices.GitRunner));
        Assert.Throws<ArgumentException>(() => GitView.Log(repo, 0, 10, "--output=x", TestServices.GitRunner));
        Assert.Throws<ArgumentException>(() => TestServices.GitRunner.CheckRoot(Path.Combine(repo, "src")));
        Assert.Throws<ArgumentException>(() => TestServices.GitRunner.CheckRoot(_dir));
        Assert.Equal(repo, TestServices.GitRunner.CheckRoot(repo));
    }

    [Fact]
    public void A_repository_without_commits_has_an_empty_history()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Directory.CreateDirectory(Path.Combine(_dir, "empty")).FullName;
        TestServices.Git.Text(repo, "init", "-q", "-b", "main");
        Write(repo, "x.txt", "x\n");
        Assert.Empty(GitView.Log(repo, 0, 10, null, TestServices.GitRunner));
        var tree = GitView.Status(repo, TestServices.GitRunner);
        Assert.False(tree.HasCommits);
        Assert.Equal(["x.txt"], tree.Untracked.Select(f => f.Path));
    }

    // ---- Actions ----

    [Fact]
    public void Files_can_be_staged_unstaged_and_restored()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        GitView.Act(repo, "unstage", "a.txt", null, hasCommits: true, TestServices.GitRunner);
        Assert.DoesNotContain(GitView.Status(repo, TestServices.GitRunner).Staged, f => f.Path == "a.txt");

        GitView.Act(repo, "discard", "a.txt", null, hasCommits: true, TestServices.GitRunner);
        Assert.Equal("one\ntwo\nthree\n", File.ReadAllText(Path.Combine(repo, "a.txt")));

        GitView.Act(repo, "discard", "gone.txt", null, hasCommits: true, TestServices.GitRunner);
        Assert.True(File.Exists(Path.Combine(repo, "gone.txt")));

        GitView.Act(repo, "stage", "notes/new.md", null, hasCommits: true, TestServices.GitRunner);
        Assert.Contains(GitView.Status(repo, TestServices.GitRunner).Staged, f => f.Path == "notes/new.md" && f.Status == "A");
    }

    [Fact]
    public void A_staged_file_restores_to_the_last_commit()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        GitView.Act(repo, "discard-all", "a.txt", null, hasCommits: true, TestServices.GitRunner);
        var tree = GitView.Status(repo, TestServices.GitRunner);
        Assert.DoesNotContain(tree.Staged, f => f.Path == "a.txt");
        Assert.DoesNotContain(tree.Unstaged, f => f.Path == "a.txt");
    }

    [Fact]
    public void Untracked_files_can_be_ignored_or_deleted()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        File.WriteAllText(Path.Combine(repo, ".gitignore"), "*.log"); // no newline at the end
        GitView.Act(repo, "ignore", "notes/new.md", null, hasCommits: true, TestServices.GitRunner);
        Assert.Equal("*.log\n/notes/new.md\n", File.ReadAllText(Path.Combine(repo, ".gitignore")));
        Assert.DoesNotContain(GitView.Status(repo, TestServices.GitRunner).Untracked, f => f.Path == "notes/new.md");

        Write(repo, "scratch.txt", "x");
        GitView.Act(repo, "delete", "scratch.txt", null, hasCommits: true, TestServices.GitRunner);
        Assert.False(File.Exists(Path.Combine(repo, "scratch.txt")));
        // Only untracked files: a tracked one stays.
        GitView.Act(repo, "delete", "src/b.cs", null, hasCommits: true, TestServices.GitRunner);
        Assert.True(File.Exists(Path.Combine(repo, "src", "b.cs")));
    }

    [Fact]
    public void Switching_branches_passes_on_what_git_refuses()
    {
        if (!HasGit())
        {
            return;
        }
        var repo = Repo();
        // feature has no a.txt change, but a.txt has changes here that a switch would carry or overwrite: fine for
        // git when they don't clash. Make one that clashes: feature changes a.txt too.
        TestServices.Git.Text(repo, "stash", "-q", "--include-untracked");
        TestServices.Git.Text(repo, "checkout", "-q", "feature");
        Write(repo, "a.txt", "feature version\n");
        TestServices.Git.Text(repo, "commit", "-q", "-am", "feature a");
        TestServices.Git.Text(repo, "checkout", "-q", "main");
        Write(repo, "a.txt", "local edit\n");

        var e = Assert.Throws<GitFailedException>(() => GitView.Act(repo, "switch", null, "refs/heads/feature", hasCommits: true, TestServices.GitRunner));
        Assert.Contains("would be overwritten", e.Detail);
        Assert.Contains("a.txt", e.Detail); // the files, not only git's first line

        TestServices.Git.Text(repo, "checkout", "-q", "--", "a.txt");
        GitView.Act(repo, "switch", null, "refs/heads/feature", hasCommits: true, TestServices.GitRunner);
        Assert.Equal("feature", GitView.Status(repo, TestServices.GitRunner).Branch);

        Assert.Throws<ArgumentException>(() => GitView.Act(repo, "switch", null, "--orphan=x", hasCommits: true, TestServices.GitRunner));
        Assert.Throws<ArgumentException>(() => GitView.Act(repo, "delete", "../outside.txt", null, hasCommits: true, TestServices.GitRunner));
    }}
