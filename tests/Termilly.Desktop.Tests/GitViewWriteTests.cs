using System.IO;
using System.Text;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

public sealed class GitViewWriteTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-write-" + Guid.NewGuid().ToString("N"));
    private string Repo => Path.Combine(_root, "repo");
    private string Origin => Path.Combine(_root, "origin.git");

    public GitViewWriteTests()
    {
        Directory.CreateDirectory(Repo);
        Git("init", "-q", "-b", "main");
        Git("config", "user.name", "Test");
        Git("config", "user.email", "test@example.com");
        Git("config", "core.hooksPath", ".hooks");
        File.WriteAllText(Path.Combine(Repo, "a.txt"), "first");
        GitWrites.Commit(Repo, "first", true, TestServices.GitRunner);
        TestServices.Git.Text(_root, "init", "--bare", Origin);
        Git("remote", "add", "origin", Origin);
    }

    private string Git(params string[] args) => TestServices.Git.Text(Repo, args);

    private void Hook(string text)
    {
        Directory.CreateDirectory(Path.Combine(Repo, ".hooks"));
        File.WriteAllText(Path.Combine(Repo, ".hooks", "pre-push"), "#!/bin/sh\n" + text + "\n");
    }

    [Fact]
    public void First_push_sets_upstream_and_returns_hook_output()
    {
        Hook("echo hook-output >&2");
        var info = GitWrites.PushInfo(Repo, TestServices.GitRunner);
        Assert.True(info.NewBranch);
        Assert.True(info.HasPrePushHook);
        Assert.Single(info.Commits);
        Assert.Equal("main", info.Branch);
        Assert.Equal(Origin.Replace('\\', '/'), info.RemoteUrl.Replace('\\', '/'));
        Git("commit", "--allow-empty", "-m", "second");
        var pushed = GitWrites.Push(Repo, TestServices.GitRunner);
        Assert.Contains("hook-output", pushed.Output);
        var after = GitWrites.PushInfo(Repo, TestServices.GitRunner);
        Assert.Equal("origin/main", after.Upstream);
        Assert.False(after.NewBranch);
        Assert.Empty(after.Commits);
        Assert.Throws<InvalidOperationException>(() => GitWrites.Undo(Repo, TestServices.GitRunner));
    }

    [Fact]
    public void Commit_without_all_includes_only_staged_files()
    {
        File.WriteAllText(Path.Combine(Repo, "staged.txt"), "staged");
        File.WriteAllText(Path.Combine(Repo, "unstaged.txt"), "unstaged");
        Git("add", "staged.txt");
        GitWrites.Commit(Repo, "staged only", false, TestServices.GitRunner);
        Assert.Equal("staged.txt", Git("diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"));
        Assert.Contains("unstaged.txt", Git("ls-files", "--others", "--exclude-standard"));
    }

    [Fact]
    public void Undo_refuses_a_commit_contained_by_a_different_remote_branch()
    {
        Git("commit", "--allow-empty", "-m", "second");
        Git("update-ref", "refs/remotes/another/topic", "HEAD");
        Assert.Throws<InvalidOperationException>(() => GitWrites.Undo(Repo, TestServices.GitRunner));
    }

    [Fact]
    public void Hook_failure_keeps_its_whole_message()
    {
        Hook("echo hook-first >&2\necho hook-last >&2\nexit 1");
        var error = Assert.Throws<GitFailedException>(() => GitWrites.Push(Repo, TestServices.GitRunner));
        Assert.Contains("hook-first", error.Detail);
        Assert.Contains("hook-last", error.Detail);
        Assert.True(GitWrites.PushInfo(Repo, TestServices.GitRunner).NewBranch);
    }

    [Fact]
    public void Undo_keeps_changes_staged_and_refuses_the_root_commit()
    {
        Assert.Throws<GitFailedException>(() => GitWrites.Undo(Repo, TestServices.GitRunner));
        Assert.Throws<ArgumentException>(() => GitWrites.Commit(Repo, " \n", true, TestServices.GitRunner));
        var first = Git("rev-parse", "HEAD");
        File.WriteAllText(Path.Combine(Repo, "a.txt"), "second");
        var created = GitWrites.Commit(Repo, "second", true, TestServices.GitRunner);
        Assert.Equal(Git("rev-parse", "HEAD"), created.Hash);
        GitWrites.Undo(Repo, TestServices.GitRunner);
        Assert.Equal(first, Git("rev-parse", "HEAD"));
        Assert.Contains("a.txt", Git("diff", "--cached", "--name-only"));
    }

    [Theory]
    [InlineData("missing")]
    [InlineData("signedOut")]
    [InlineData("notGitHub")]
    [InlineData("unreachable")]
    public void GitHub_status_reports_unavailability(string reason)
    {
        if (reason != "notGitHub")
        {
            Git("remote", "set-url", "origin", "https://github.com/a/b.git");
        }
        var runner = new RecordingRunner(request => reason switch
        {
            "missing" => throw new ProgramMissingException("gh", new IOException()),
            "signedOut" => new ProcessResult(1, [], "", false),
            // Signed in (gh keeps that on this computer), but GitHub doesn't answer.
            "unreachable" => new ProcessResult(request.Arguments[0] == "auth" ? 0 : 1, [], "dial tcp: timeout", false),
            _ => new ProcessResult(0, [], "", false),
        });
        var result = new GitHub(runner, TestServices.GitRunner).Status(Repo);
        Assert.False(result.Available);
        Assert.Equal(reason, result.Reason);
    }

    [Fact]
    public void GitHub_status_stays_usable_when_only_the_login_lookup_fails()
    {
        Git("remote", "set-url", "origin", "https://github.com/a/b.git");
        var runner = new RecordingRunner(request => request.Arguments[0] switch
        {
            "repo" => new ProcessResult(0, Encoding.UTF8.GetBytes("{\"nameWithOwner\":\"a/b\",\"defaultBranchRef\":{\"name\":\"main\"},\"isPrivate\":true}"), "", false),
            "api" => new ProcessResult(1, [], "dial tcp: timeout", false),
            _ => new ProcessResult(0, [], "", false),
        });
        var result = new GitHub(runner, TestServices.GitRunner).Status(Repo);
        Assert.Equal(new GitHubAvailability(true, Repo: "a/b", DefaultBranch: "main", IsPublic: false, Login: null), result);
    }

    [Fact]
    public void GitHub_reads_and_pr_creation_have_their_own_timeouts()
    {
        Git("remote", "set-url", "origin", "https://github.com/a/b.git");
        var runner = new RecordingRunner(request => new ProcessResult(0,
            Encoding.UTF8.GetBytes(request.Arguments.Contains("create") ? "https://github.com/a/b/pull/7\n" : "[]"), "", false));
        var github = new GitHub(runner, TestServices.GitRunner);
        Assert.Empty(github.Issues(Repo, "open", null).AsArray());
        Assert.Equal(TimeSpan.FromSeconds(30), runner.Requests[0].Timeout);
        Assert.Equal("https://github.com/a/b.git", runner.Requests[0].Environment!["GH_REPO"]);
        var pr = github.PrCreate(Repo, new FromPage.GitHubPrCreate(Base: "main", Head: "fix", Title: "Fix"));
        Assert.Equal(7, pr.Number);
        Assert.Equal(TimeSpan.FromSeconds(60), runner.Requests[1].Timeout);
        Assert.Null(runner.Requests[1].CommandLine);
    }

    [Fact]
    public void GitHub_status_and_pull_request_lookup_parse_cli_json()
    {
        Git("remote", "set-url", "origin", "git@github.com:a/b.git");
        var runner = new RecordingRunner(request => new ProcessResult(0, Encoding.UTF8.GetBytes(request.Arguments[0] switch
        {
            "repo" => "{\"nameWithOwner\":\"a/b\",\"defaultBranchRef\":{\"name\":\"main\"},\"isPrivate\":false}",
            "api" => "alice\n",
            "pr" => "[{\"number\":7,\"url\":\"https://github.com/a/b/pull/7\",\"state\":\"OPEN\"}]",
            _ => "",
        }), "", false));
        var github = new GitHub(runner, TestServices.GitRunner);
        Assert.Equal(new GitHubAvailability(true, Repo: "a/b", DefaultBranch: "main", IsPublic: true, Login: "alice"), github.Status(Repo));
        Assert.Equal(new GitHubPullRequest(7, "https://github.com/a/b/pull/7", "OPEN"), github.PrFor(Repo, "fix"));
        var empty = new GitHub(new RecordingRunner(_ => new ProcessResult(0, Encoding.UTF8.GetBytes("[]"), "", false)), TestServices.GitRunner);
        Assert.Null(empty.PrFor(Repo, "absent"));
    }

    [Fact]
    public void Ssh_writes_quote_text_and_preserve_long_hook_errors()
    {
        var detail = new string('x', 5000) + "hook-final";
        var runner = new RecordingRunner(_ => new ProcessResult(1, Encoding.UTF8.GetBytes("output"), detail, false));
        var ssh = new SshGitRunner(runner, "server", null);
        var error = Assert.Throws<GitFailedException>(() => ssh.Write("/repo", ["commit", "--message", "it's $safe"], TimeSpan.FromMinutes(2)));
        Assert.Equal("output" + detail, error.Detail);
        Assert.Equal(TimeSpan.FromMinutes(2), runner.Requests[0].Timeout);
        Assert.Contains("GIT_TERMINAL_PROMPT=0", runner.Requests[0].CommandLine!);
        Assert.Contains("$safe", runner.Requests[0].CommandLine!);
    }

    private sealed class RecordingRunner(Func<ProcessRequest, ProcessResult> run) : IProcessRunner
    {
        public List<ProcessRequest> Requests { get; } = [];

        public ProcessResult Run(ProcessRequest request)
        {
            Requests.Add(request);
            return run(request);
        }

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
