using System.IO;
using System.Text;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

public sealed class GitSafetyTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-safety-" + Guid.NewGuid().ToString("N"));
    private static LocalGitRunner Runner => TestServices.GitRunner;
    private string FilePath => Path.Combine(_root, "a.txt");

    public GitSafetyTests()
    {
        Directory.CreateDirectory(_root);
        Git("init", "-q", "-b", "main");
        Git("config", "user.name", "Test");
        Git("config", "user.email", "test@example.com");
        Git("config", "core.autocrlf", "false");
        File.WriteAllText(FilePath, "one\ntwo\nthree\n");
        Git("add", ".");
        Git("commit", "-qm", "first");
    }

    private string Git(params string[] args) => TestServices.Git.Text(_root, args);
    private Snapshot Take() => GitSnapshots.Take(_root, SnapshotReasons.Manual, Runner)!;
    private void Diff(string side = DiffSides.Unstaged) => GitView.Diff(_root, new GitDiffTarget("a.txt", null, side), GitSnapshots.MaxFileBytes, Runner);
    private void Lines(string action, int[] removed, int[] added, string side = DiffSides.Unstaged) =>
        GitStageLines.Apply(_root, "a.txt", side, action, removed, added, Runner);

    [Fact]
    public void Snapshot_preserves_index_and_files_skips_unchanged_and_restores_deletions()
    {
        File.WriteAllText(FilePath, "staged\n");
        Git("add", "a.txt");
        File.WriteAllText(FilePath, "working\n");
        File.WriteAllText(Path.Combine(_root, "new.txt"), "new");
        var index = Git("show", ":a.txt");
        var snapshot = Take();
        Assert.Equal(index, Git("show", ":a.txt"));
        Assert.Equal("working\n", File.ReadAllText(FilePath));
        Assert.Contains(snapshot.Files, f => f.Path == "new.txt" && f.Status == "A");
        Assert.Null(GitSnapshots.Take(_root, SnapshotReasons.Timer, Runner));
        File.Delete(FilePath);
        var deleted = Take();
        GitSnapshots.Restore(_root, snapshot.Id, null, Runner);
        Assert.Equal("working\n", File.ReadAllText(FilePath));
        GitSnapshots.Restore(_root, deleted.Id, ["a.txt"], Runner);
        Assert.False(File.Exists(FilePath));
        Assert.Equal(index, Git("show", ":a.txt"));
    }

    [Fact]
    public void Snapshot_restore_undo_removes_new_untracked_files()
    {
        File.WriteAllText(Path.Combine(_root, "new.txt"), "saved");
        var saved = Take();
        File.Delete(Path.Combine(_root, "new.txt"));
        var result = GitSnapshots.Restore(_root, saved.Id, null, Runner);
        Assert.NotNull(result.Before);
        Assert.True(File.Exists(Path.Combine(_root, "new.txt")));
        GitSnapshots.Restore(_root, result.Before, null, Runner);
        Assert.False(File.Exists(Path.Combine(_root, "new.txt")));
    }

    [Fact]
    public void Undoing_one_restored_file_that_was_not_there_before_removes_it()
    {
        File.WriteAllText(Path.Combine(_root, "new.txt"), "kept");
        var saved = GitSnapshots.Take(_root, SnapshotReasons.Manual, Runner)!;
        File.Delete(Path.Combine(_root, "new.txt"));

        var result = GitSnapshots.Restore(_root, saved.Id, ["new.txt"], Runner);
        Assert.Equal("kept", File.ReadAllText(Path.Combine(_root, "new.txt")));
        GitSnapshots.Restore(_root, result.Before, ["new.txt"], Runner);
        Assert.False(File.Exists(Path.Combine(_root, "new.txt")));
        // Any other snapshot still refuses a file it doesn't have.
        Assert.Throws<ArgumentException>(() => GitSnapshots.Restore(_root, saved.Id, ["other.txt"], Runner));
    }

    [Fact]
    public void Snapshot_omits_large_files_and_ignored_files()
    {
        File.WriteAllText(Path.Combine(_root, ".gitignore"), "ignored\n");
        File.WriteAllText(Path.Combine(_root, "ignored"), "secret");
        File.WriteAllBytes(Path.Combine(_root, "large"), new byte[GitSnapshots.MaxFileBytes + 1]);
        var snapshot = Take();
        Assert.Equal(1, snapshot.Skipped);
        Assert.DoesNotContain(snapshot.Files, f => f.Path is "large" or "ignored");
        GitSnapshots.Restore(_root, snapshot.Id, null, Runner);
        Assert.True(File.Exists(Path.Combine(_root, "large")));
    }

    [Fact]
    public void Snapshot_retention_keeps_only_recent_hundred()
    {
        var initial = Take();
        var prefix = initial.Id[..(initial.Id.LastIndexOf('/') + 1)];
        var hash = Git("rev-parse", initial.Id);
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        for (var i = 1; i <= GitSnapshots.MaxSnapshots; i++)
        {
            Git("update-ref", prefix + (now - i), hash);
        }
        Git("update-ref", prefix + DateTimeOffset.UtcNow.AddDays(-31).ToUnixTimeMilliseconds(), hash);
        File.WriteAllText(FilePath, "changed");
        Take();
        var list = GitSnapshots.List(_root, Runner);
        Assert.Equal(GitSnapshots.MaxSnapshots, list.Count);
        Assert.All(list, s => Assert.True(DateTimeOffset.Parse(s.At, System.Globalization.CultureInfo.InvariantCulture) > DateTimeOffset.UtcNow.AddDays(-30)));
    }

    [Fact]
    public void Snapshot_linked_worktree_has_its_own_namespace()
    {
        var linked = _root + "-linked";
        try
        {
            Git("worktree", "add", "-b", "topic", linked);
            var main = Take();
            File.WriteAllText(Path.Combine(linked, "a.txt"), "linked");
            var snapshot = GitSnapshots.Take(linked, SnapshotReasons.Manual, Runner)!;
            Assert.NotEqual(main.Id[..main.Id.LastIndexOf('/')], snapshot.Id[..snapshot.Id.LastIndexOf('/')]);
            Assert.Single(GitSnapshots.List(_root, Runner));
            Assert.Single(GitSnapshots.List(linked, Runner));
            Assert.Throws<ArgumentException>(() => GitSnapshots.Restore(_root, snapshot.Id, null, Runner));
        }
        finally
        {
            Git("worktree", "remove", "--force", linked);
        }
    }

    [Fact]
    public void Backup_undo_and_restore_choose_unused_names()
    {
        File.WriteAllText(FilePath, "second");
        GitWrites.Commit(_root, "second", true, Runner);
        var tip = Git("rev-parse", "HEAD");
        GitWrites.Undo(_root, Runner);
        var backup = Assert.Single(GitBackups.List(_root, Runner));
        Assert.Equal(BackupEvents.UndoCommit, backup.Event);
        Assert.Equal(tip, backup.Hash);
        Assert.Equal("main-restored", GitBackups.Restore(_root, backup.Id, Runner).Branch);
        Assert.Equal("main-restored-2", GitBackups.Restore(_root, backup.Id, Runner).Branch);
        Assert.Equal(tip, Git("rev-parse", "main-restored"));
        Assert.Throws<ArgumentException>(() => GitBackups.Restore(_root, "refs/heads/main", Runner));
    }

    [Fact]
    public void StageLines_stage_and_unstage_some_lines_leave_working_text()
    {
        File.WriteAllText(FilePath, "ONE\ntwo\nTHREE\n");
        Diff();
        Lines(StageLineActions.Stage, [1], [1]);
        Assert.Equal("ONE\ntwo\nthree", Git("show", ":a.txt"));
        Assert.Equal("ONE\ntwo\nTHREE\n", File.ReadAllText(FilePath));
        Diff(DiffSides.Staged);
        Lines(StageLineActions.Unstage, [1], [1], DiffSides.Staged);
        Assert.Equal("one\ntwo\nthree", Git("show", ":a.txt"));
    }

    [Fact]
    public void StageLines_discard_keeps_line_endings_and_takes_snapshot()
    {
        File.WriteAllText(FilePath, "ONE\r\ntwo\r\nTHREE\r\n");
        Diff();
        Lines(StageLineActions.Discard, [1], [1]);
        Assert.Equal("one\r\ntwo\r\nTHREE\r\n", File.ReadAllText(FilePath));
        Assert.Equal(SnapshotReasons.BeforeDiscard, Assert.Single(GitSnapshots.List(_root, Runner)).Reason);
    }

    [Fact]
    public void StageLines_refuses_stale_lines_invalid_selections_and_new_files()
    {
        File.WriteAllText(FilePath, "ONE\ntwo\nthree\n");
        Diff();
        Assert.Throws<ArgumentException>(() => Lines(StageLineActions.Stage, [2], []));
        File.WriteAllText(FilePath, "other");
        Assert.Throws<InvalidOperationException>(() => Lines(StageLineActions.Stage, [1], [1]));
        Assert.Throws<ArgumentException>(() => Lines(StageLineActions.Stage, [1], [1], DiffSides.Staged));
        File.WriteAllText(Path.Combine(_root, "new.txt"), "new");
        GitView.Diff(_root, new GitDiffTarget("new.txt", null, DiffSides.Unstaged), GitSnapshots.MaxFileBytes, Runner);
        Assert.Throws<InvalidOperationException>(() => GitStageLines.Apply(_root, "new.txt", DiffSides.Unstaged, StageLineActions.Stage, [], [1], Runner));
    }

    [Fact]
    public void Worktree_remove_refuses_main_current_and_dirty_then_snapshots_force()
    {
        Assert.Throws<InvalidOperationException>(() => GitCleanup.Remove(_root, _root, true, Runner));
        var linked = _root + "-linked";
        try
        {
            Git("worktree", "add", "-b", "topic", linked);
            File.WriteAllText(Path.Combine(linked, "new"), "work");
            var item = Assert.Single(GitCleanup.Worktrees(_root, Runner), w => !w.Main);
            Assert.Equal(1, item.Changes);
            Assert.Contains("1 uncommitted", Assert.Throws<InvalidOperationException>(() => GitCleanup.Remove(_root, linked, false, Runner)).Message);
            Assert.Throws<InvalidOperationException>(() => GitCleanup.Remove(linked, linked, true, Runner));
            GitCleanup.Remove(_root, linked, true, Runner);
            Assert.False(Directory.Exists(linked));
            Assert.Contains("topic", Git("branch", "--list"));
            Assert.Contains("beforeRemove", Git("log", "--all", "--format=%B"));
            // Its work shows in the main worktree's Local history, and comes back there.
            var kept = Assert.Single(GitSnapshots.List(_root, Runner, removed: true), s => s.Reason == SnapshotReasons.BeforeRemove);
            Assert.DoesNotContain(GitSnapshots.List(_root, Runner), s => s.Id == kept.Id);
            GitSnapshots.Restore(_root, kept.Id, ["new"], Runner);
            Assert.Equal("work", File.ReadAllText(Path.Combine(_root, "new")));
        }
        finally
        {
            if (Directory.Exists(linked))
            {
                Git("worktree", "remove", "--force", linked);
            }
        }
    }

    [Fact]
    public void Prune_candidates_exclude_protected_and_checked_out_and_backup_deleted_tips()
    {
        Git("branch", "merged");
        Git("branch", "develop");
        var candidates = GitCleanup.Candidates(_root, Runner);
        Assert.Equal("main", candidates.Base);
        var candidate = Assert.Single(candidates.Branches);
        Assert.Equal("merged", candidate.Name);
        Assert.Contains(PruneReasons.Merged, candidate.Reasons);
        Assert.Throws<ArgumentException>(() => GitCleanup.Prune(_root, ["main"], Runner));
        var result = GitCleanup.Prune(_root, ["merged"], Runner);
        Assert.Equal(["merged"], result.Deleted);
        Assert.Single(result.Backups);
        Assert.Equal("merged", GitBackups.Restore(_root, result.Backups[0], Runner).Branch);
    }

    [Fact]
    public void GitView_log_all_and_path_include_other_branches_and_filter_files()
    {
        Git("switch", "-c", "topic");
        File.WriteAllText(Path.Combine(_root, "other.txt"), "other");
        GitWrites.Commit(_root, "other", true, Runner);
        Git("switch", "main");
        Assert.Single(GitView.Log(_root, 0, 100, null, Runner));
        Assert.Equal(2, GitView.Log(_root, 0, 100, null, Runner, all: true).Count);
        Assert.Single(GitView.Log(_root, 0, 100, null, Runner, all: true, path: "a.txt"));
        Assert.Throws<ArgumentException>(() => GitView.Log(_root, 0, 100, null, Runner, path: "../outside"));
    }

    [Fact]
    public void Snapshot_handles_staged_deletions_and_unborn_branches()
    {
        Git("rm", "a.txt");
        var deleted = Take();
        Assert.Contains(deleted.Files, f => f.Path == "a.txt" && f.Status == "D");
        Assert.Equal("", Git("ls-tree", "--name-only", deleted.Id));
        Git("switch", "--orphan", "unborn");
        File.WriteAllText(FilePath, "first work");
        var first = Take();
        Assert.Equal("first work", Git("show", first.Id + ":a.txt"));
        Assert.Equal("", Git("show", "-s", "--format=%P", first.Id));
    }

    [Theory]
    [InlineData(GitActions.Discard)]
    [InlineData(GitActions.DiscardAll)]
    [InlineData(GitActions.Delete)]
    public void Snapshot_is_automatic_before_destructive_file_actions(string action)
    {
        var path = action == GitActions.Delete ? "new.txt" : "a.txt";
        File.WriteAllText(Path.Combine(_root, path), "save me");
        GitView.Act(_root, action, path, null, true, Runner);
        var snapshot = Assert.Single(GitSnapshots.List(_root, Runner));
        Assert.Equal(SnapshotReasons.BeforeDiscard, snapshot.Reason);
        Assert.Equal("save me", Git("show", snapshot.Id + ":" + path));
    }

    [Fact]
    public void Snapshot_failure_stops_discard_and_backup_failure_stops_undo()
    {
        File.WriteAllText(FilePath, "save me");
        var failing = new LocalGitRunner(new FailingRefRunner());
        Assert.Throws<GitFailedException>(() => GitView.Act(_root, GitActions.Discard, "a.txt", null, true, failing));
        Assert.Equal("save me", File.ReadAllText(FilePath));
        GitWrites.Commit(_root, "second", true, Runner);
        var head = Git("rev-parse", "HEAD");
        Assert.Throws<GitFailedException>(() => GitWrites.Undo(_root, failing));
        Assert.Equal(head, Git("rev-parse", "HEAD"));
    }

    [Fact]
    public void Backup_retention_expires_old_refs_and_supports_slashes()
    {
        Git("branch", "feature/topic");
        var old = "refs/termilly/backups/" + DateTimeOffset.UtcNow.AddDays(-31).ToUnixTimeMilliseconds() + "/prune/feature/topic";
        Git("update-ref", old, "HEAD");
        var id = GitBackups.Take(_root, "feature/topic", BackupEvents.Prune, Runner);
        Assert.Equal(id, Assert.Single(GitBackups.List(_root, Runner)).Id);
        Git("branch", "-D", "feature/topic");
        Assert.Equal("feature/topic", GitBackups.Restore(_root, id, Runner).Branch);
    }

    [Theory]
    [InlineData("binary")]
    [InlineData("large")]
    [InlineData("deleted")]
    [InlineData("renamed")]
    public void StageLines_refuses_whole_file_changes(string kind)
    {
        var path = "a.txt";
        var side = DiffSides.Unstaged;
        switch (kind)
        {
            case "binary": File.WriteAllBytes(FilePath, [0, 1, 2]); break;
            case "large": File.WriteAllText(FilePath, new string('x', (int)GitSnapshots.MaxFileBytes + 1)); break;
            case "deleted": File.Delete(FilePath); break;
            case "renamed": Git("mv", "a.txt", "b.txt"); path = "b.txt"; side = DiffSides.Staged; break;
        }
        GitView.Diff(_root, new GitDiffTarget(path, kind == "renamed" ? "a.txt" : null, side), GitSnapshots.MaxFileBytes, Runner);
        Assert.Throws<InvalidOperationException>(() => GitStageLines.Apply(_root, path, side,
            side == DiffSides.Staged ? StageLineActions.Unstage : StageLineActions.Stage, [1], [1], Runner));
    }

    [Fact]
    public void Prune_detects_gone_and_old_and_excludes_worktrees()
    {
        Git("branch", "gone");
        Git("config", "branch.gone.remote", "origin");
        Git("config", "branch.gone.merge", "refs/heads/gone");
        Git("remote", "add", "origin", _root + "-missing");
        Git("update-ref", "refs/remotes/origin/gone", "HEAD");
        Git("branch", "--set-upstream-to", "origin/gone", "gone");
        Git("update-ref", "-d", "refs/remotes/origin/gone");
        var commit = Encoding.UTF8.GetString(Runner.WithInput(_root, ["commit-tree", "HEAD^{tree}"], "old",
            new Dictionary<string, string> { ["GIT_AUTHOR_DATE"] = "2020-01-01T00:00:00Z", ["GIT_COMMITTER_DATE"] = "2020-01-01T00:00:00Z" })).Trim();
        Git("branch", "old", commit);
        var linked = _root + "-linked";
        try
        {
            Git("worktree", "add", "-b", "checked", linked);
            var result = GitCleanup.Candidates(_root, Runner);
            Assert.Contains(PruneReasons.Gone, Assert.Single(result.Branches, b => b.Name == "gone").Reasons);
            Assert.Contains(PruneReasons.Old, Assert.Single(result.Branches, b => b.Name == "old").Reasons);
            Assert.DoesNotContain(result.Branches, b => b.Name == "checked");
        }
        finally
        {
            Git("worktree", "remove", "--force", linked);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void StageLines_preserves_encoding_marks(bool utf16)
    {
        var encoding = utf16 ? Encoding.Unicode : new UTF8Encoding(true);
        File.WriteAllText(FilePath, "one\ntwo\nthree\n", encoding);
        Git("add", "a.txt");
        Git("commit", "-qm", "encoding");
        File.WriteAllText(FilePath, "ONE\ntwo\nTHREE\n", encoding);
        Diff();
        Lines(StageLineActions.Stage, [1], [1]);
        var staged = Runner.Run(_root, ["cat-file", "blob", ":a.txt"]);
        Assert.True(staged.AsSpan().StartsWith(encoding.GetPreamble()));
        Assert.Equal("ONE\ntwo\nthree\n", Blob.From(staged, GitSnapshots.MaxFileBytes).Text());
        Diff();
        Lines(StageLineActions.Discard, [3], [3]);
        Assert.Equal("ONE\ntwo\nthree\n", File.ReadAllText(FilePath));
        Assert.True(File.ReadAllBytes(FilePath).AsSpan().StartsWith(encoding.GetPreamble()));
    }

    [Fact]
    public void StageLines_preserves_the_last_lines_newline_and_mixed_unchanged_endings()
    {
        Assert.Equal("one\nTWO", GitStageLines.Pick("one\ntwo\n", "one\nTWO", [2], [2], true));
        Assert.Equal("one\r\ntwo\nthree\r\n", GitStageLines.Pick("one\r\ntwo\nthree\r\n", "ONE\r\ntwo\nthree\r\n", [1], [1], false));
    }

    [Fact]
    public void Snapshot_and_backup_requests_refuse_remote_repositories()
    {
        var ssh = new SshGitRunner(TestServices.Runner, "unused", null);
        Assert.Throws<InvalidOperationException>(() => GitSnapshots.Take("/repo", SnapshotReasons.Manual, ssh));
        Assert.Throws<InvalidOperationException>(() => GitBackups.List("/repo", ssh));
        Assert.Null(GitSnapshots.Before("/repo", SnapshotReasons.BeforeDiscard, ssh));
    }

    [Fact]
    public void GitView_log_follows_a_deleted_renamed_file_and_handles_folders()
    {
        Directory.CreateDirectory(Path.Combine(_root, "folder"));
        Git("mv", "a.txt", "folder/renamed.txt");
        Git("commit", "-qm", "rename");
        Git("rm", "folder/renamed.txt");
        Git("commit", "-qm", "delete");
        Assert.Equal(3, GitView.Log(_root, 0, 100, null, Runner, path: "folder/renamed.txt").Count);
        Assert.Equal(2, GitView.Log(_root, 0, 100, null, Runner, path: "folder").Count);
    }

    private sealed class FailingRefRunner : IProcessRunner
    {
        public ProcessResult Run(ProcessRequest request) => request.Arguments.Contains("update-ref")
            ? new ProcessResult(1, [], "Ref write refused", false) : TestServices.Runner.Run(request);

        public Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancel = default) => Task.FromResult(Run(request));
    }

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(_root, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal);
        }
        Directory.Delete(_root, true);
    }
}
