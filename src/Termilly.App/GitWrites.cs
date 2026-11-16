using Termilly.Desktop.Services;

namespace Termilly.Desktop;

internal sealed record GitPushCommit(string Hash, string Subject, string Author);
internal sealed record GitPushInfo(string Branch, string Remote, string RemoteUrl, string? Upstream,
    bool NewBranch, IReadOnlyList<GitPushCommit> Commits, bool HasPrePushHook);
internal sealed record GitPushOutput(string Output);
internal sealed record GitCreatedCommit(string Hash);

internal static class GitWrites
{
    private const string Origin = GitCommands.Origin;
    private const string Parent = "HEAD~1";
    /// <summary>
    /// How long a push or a commit may take: the repository's own hooks (pre-commit, pre-push) run inside them and can
    /// run a project's checks, which take far longer than git itself.
    /// </summary>
    private static readonly TimeSpan PushTimeout = TimeSpan.FromMinutes(2);
    private static readonly TimeSpan CommitTimeout = PushTimeout;

    public static GitPushInfo PushInfo(string root, GitRunner git)
    {
        var branch = GitView.Text(git, root, GitCommands.SymbolicRef, GitCommands.QuietLong, GitCommands.Short, GitCommands.Head).Trim();
        var upstream = GitView.Text(git, root, GitCommands.ForEachRef, "--format=%(upstream:short)", "refs/heads/" + branch).Trim();
        var remote = upstream.Length == 0 ? Origin : GitView.Text(git, root, "config", "--get", "branch." + branch + ".remote").Trim();
        var url = GitView.Text(git, root, GitCommands.Remote, GitCommands.Options.GetUrl, "--push", remote).Trim();
        var range = upstream.Length == 0 ? new[] { GitCommands.Head, "--not", "--remotes=" + remote } : new[] { upstream + "..HEAD" };
        var raw = GitView.Text(git, root, [GitCommands.Log, "--format=%H%x00%s%x00%an", .. range]);
        var commits = raw.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.TrimEnd('\r').Split('\0'))
            .Select(fields => new GitPushCommit(fields[0], fields[1], fields[2])).ToList();
        var exists = git.HasPrePushHook(root);
        return new GitPushInfo(branch, remote, url, upstream.Length == 0 ? null : upstream, upstream.Length == 0, commits, exists);
    }

    public static GitPushOutput Push(string root, GitRunner git)
    {
        var info = PushInfo(root, git);
        var branch = info.NewBranch ? info.Branch : info.Upstream![(info.Remote.Length + 1)..];
        var target = GitCommands.Head + ":" + GitCommands.Refs.HeadsPrefix + branch;
        // Push the destination shown in the dialog even when push.default or pushRemote says otherwise.
        var args = info.NewBranch
            ? new[] { GitCommands.Push, "--set-upstream", GitCommands.Options.Paths, Origin, target }
            : new[] { GitCommands.Push, GitCommands.Options.Paths, info.Remote, target };
        return new GitPushOutput(git.Write(root, args, PushTimeout));
    }

    public static GitCreatedCommit Commit(string root, string? message, bool all, GitRunner git)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            throw new ArgumentException("Enter a commit message.");
        }
        if (all)
        {
            git.Write(root, [GitCommands.Add, "--all"], ProcessRunner.DefaultTimeout);
        }
        git.Write(root, ["commit", "--message", message], CommitTimeout);
        return new GitCreatedCommit(GitView.Text(git, root, GitCommands.RevParse, GitCommands.Head).Trim());
    }

    public static object? Undo(string root, GitRunner git)
    {
        git.Run(root, [GitCommands.RevParse, GitCommands.Verify, Parent]);
        if (GitView.Text(git, root, GitCommands.ForEachRef, "--contains=HEAD", "--format=%(refname)", "refs/remotes/").Trim().Length > 0)
        {
            throw new InvalidOperationException("This commit is already on a remote branch.");
        }
        var branch = GitView.Text(git, root, GitCommands.Branch, GitCommands.Options.ShowCurrent).Trim();
        if (branch.Length == 0)
        {
            throw new InvalidOperationException("Check out a branch before undoing a commit.");
        }
        if (git is LocalGitRunner)
        {
            GitBackups.Take(root, branch, BackupEvents.UndoCommit, git);
        }
        git.Write(root, ["reset", "--soft", Parent], ProcessRunner.DefaultTimeout);
        return null;
    }
}
