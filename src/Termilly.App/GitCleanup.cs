using System.Globalization;

namespace Termilly.Desktop;

internal static class PruneReasons
{
    public const string Merged = "merged";
    public const string Gone = "gone";
    public const string Old = "old";
    public static readonly IReadOnlyList<string> All = [Merged, Gone, Old];
}

internal sealed record GitWorktree(string Path, string? Branch, string Head, bool Main, bool Current, int Changes, bool Locked, bool Prunable);
internal sealed record PruneCandidate(string Name, IReadOnlyList<string> Reasons, string LastDate, int Unmerged, string? Worktree);
internal sealed record PruneCandidates(string? Base, IReadOnlyList<PruneCandidate> Branches);
internal sealed record PruneResult(IReadOnlyList<string> Deleted, IReadOnlyList<string> Backups);

internal static class GitCleanup
{
    private const string OriginPrefix = "origin/";
    private const int OldDays = 90;
    private static readonly string[] Protected = ["main", "master", "develop"];

    public static IReadOnlyList<GitWorktree> Worktrees(string root, GitRunner git)
    {
        var blocks = GitView.Text(git, root, GitCommands.Worktree, GitCommands.List, GitCommands.Porcelain, GitCommands.Options.NulTerminated).Split("\0\0", StringSplitOptions.RemoveEmptyEntries);
        return blocks.Select((block, index) => ReadWorktree(root, git, block, index == 0)).ToList();
    }

    private static GitWorktree ReadWorktree(string root, GitRunner git, string block, bool main)
    {
        var fields = block.Split('\0', StringSplitOptions.RemoveEmptyEntries);
        string Value(string name) => fields.FirstOrDefault(f => f.StartsWith(name + " ", StringComparison.Ordinal))?[(name.Length + 1)..] ?? "";
        var path = Value(GitCommands.Worktree);
        var branch = Value(GitCommands.Branch);
        var prunable = fields.Any(f => f == "prunable" || f.StartsWith("prunable ", StringComparison.Ordinal));
        var count = prunable ? 0 : Changes(path, git);
        return new GitWorktree(path, branch.Length == 0 ? null : branch[GitCommands.Refs.HeadsPrefix.Length..], Value(GitCommands.Head), main,
            SamePath(path, root, git), count, fields.Any(f => f == "locked" || f.StartsWith("locked ", StringComparison.Ordinal)), prunable);
    }

    private static int Changes(string root, GitRunner git)
    {
        var status = GitOutput.Status(root, GitView.Text(git, root, GitView.StatusCommand));
        return status.Staged.Concat(status.Unstaged).Concat(status.Untracked).Concat(status.Conflicted)
            .Select(f => f.Path).Distinct(StringComparer.Ordinal).Count();
    }

    private static bool SamePath(string a, string b, GitRunner git) => string.Equals(a.TrimEnd('/', '\\').Replace('\\', '/'), b.TrimEnd('/', '\\').Replace('\\', '/'),
        git is LocalGitRunner && OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    public static GitActionDone Remove(string root, string? path, bool force, GitRunner git)
    {
        var item = Worktrees(root, git).FirstOrDefault(w => path is not null && SamePath(w.Path, path, git))
            ?? throw new ArgumentException("That worktree isn't in the repository.");
        if (item.Main || item.Current || item.Locked)
        {
            throw new InvalidOperationException("The main, current or locked worktree cannot be removed.");
        }
        if (!force && item.Changes > 0)
        {
            throw new InvalidOperationException($"It has {item.Changes} uncommitted changes.");
        }
        if (force && !item.Prunable)
        {
            GitSnapshots.Before(item.Path, SnapshotReasons.BeforeRemove, git);
        }
        git.Run(root, force ? [GitCommands.Worktree, GitCommands.RemoveWorktree, "--force", GitCommands.Options.Paths, item.Path] : [GitCommands.Worktree, GitCommands.RemoveWorktree, GitCommands.Options.Paths, item.Path]);
        return new GitActionDone(true);
    }

    public static PruneCandidates Candidates(string root, GitRunner git)
    {
        var branches = GitView.Branches(root, git).Where(b => !b.Remote).ToList();
        var baseBranch = DefaultBranch(root, git, branches);
        if (baseBranch is null)
        {
            return new PruneCandidates(null, []);
        }
        var worktrees = Worktrees(root, git);
        var baseName = baseBranch.StartsWith(OriginPrefix, StringComparison.Ordinal) ? baseBranch[OriginPrefix.Length..] : baseBranch;
        var candidates = new List<PruneCandidate>();
        foreach (var branch in branches.Where(b => !b.Current && b.Name != baseBranch && b.Name != baseName && !Protected.Contains(b.Name) && !worktrees.Any(w => w.Branch == b.Name)))
        {
            var unmerged = int.Parse(GitView.Text(git, root, "rev-list", "--count", baseBranch + GitCommands.Range + branch.Ref).Trim(), CultureInfo.InvariantCulture);
            var reasons = new List<string>();
            if (unmerged == 0)
            {
                reasons.Add(PruneReasons.Merged);
            }
            if (branch.Gone)
            {
                reasons.Add(PruneReasons.Gone);
            }
            if (DateTimeOffset.Parse(branch.Date, CultureInfo.InvariantCulture) < DateTimeOffset.UtcNow.AddDays(-OldDays))
            {
                reasons.Add(PruneReasons.Old);
            }
            if (reasons.Count > 0)
            {
                candidates.Add(new PruneCandidate(branch.Name, reasons, branch.Date, unmerged, null));
            }
        }
        return new PruneCandidates(baseBranch, candidates);
    }

    private static string? DefaultBranch(string root, GitRunner git, IReadOnlyList<GitBranchInfo> branches)
    {
        try
        {
            return GitView.Text(git, root, GitCommands.SymbolicRef, GitCommands.QuietLong, GitCommands.Short, "refs/remotes/origin/HEAD").Trim();
        }
        catch (GitFailedException)
        {
            return Protected.FirstOrDefault(name => branches.Any(b => b.Name == name));
        }
    }

    public static PruneResult Prune(string root, IReadOnlyList<string>? branches, GitRunner git)
    {
        var selected = branches?.Distinct(StringComparer.Ordinal).ToList() ?? [];
        var allowed = Candidates(root, git).Branches.Select(b => b.Name).ToHashSet(StringComparer.Ordinal);
        if (selected.Any(b => !allowed.Contains(b)))
        {
            throw new ArgumentException("A selected branch is no longer a cleanup candidate.");
        }
        // Keep every original tip before deleting any of them, so a failed backup cannot leave a partial cleanup.
        var backups = git is LocalGitRunner ? selected.Select(b => GitBackups.Take(root, b, BackupEvents.Prune, git)).ToList() : [];
        foreach (var branch in selected)
        {
            git.Run(root, [GitCommands.Branch, GitCommands.DeleteBranch, GitCommands.Options.Paths, branch]);
        }
        return new PruneResult(selected, backups);
    }
}
