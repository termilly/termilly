using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Termilly.Desktop;

internal static class SnapshotReasons
{
    public const string Timer = "timer";
    public const string AgentStart = "agentStart";
    public const string BeforeDiscard = "beforeDiscard";
    public const string BeforeRestore = "beforeRestore";
    public const string BeforeRemove = "beforeRemove";
    public const string Manual = "manual";
    public static readonly IReadOnlyList<string> All = [Timer, AgentStart, BeforeDiscard, BeforeRestore, BeforeRemove, Manual];
}

internal sealed record Snapshot(string Id, string At, string Reason, string? Branch, IReadOnlyList<GitFile> Files, int Skipped);
internal sealed record SnapshotRestoreResult(string? Before);
internal sealed record SnapshotMetadata(string Reason, string? Branch, int Skipped, IReadOnlyList<string>? SkippedPaths = null);

internal static class GitSnapshots
{
    private const string OtherFiles = "--others";
    private const string ExcludeIgnored = "--exclude-standard";
    private const string Prefix = "refs/termilly/snapshots/";
    private const string IndexVariable = "GIT_INDEX_FILE";
    private const int KeyLength = 16;
    internal const int MaxSnapshots = 100;
    internal const int RetentionDays = 30;
    internal const long MaxFileBytes = 5L * 1024 * 1024;
    private static readonly Lock Gate = new();

    internal static void RequireLocal(GitRunner git)
    {
        if (git is not LocalGitRunner)
        {
            throw new InvalidOperationException("Local history works on this computer's repositories.");
        }
    }

    private static string Namespace(string root)
    {
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var normalized = OperatingSystem.IsWindows() ? full.ToUpperInvariant() : full;
        return Prefix + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))[..KeyLength] + "/";
    }

    /// <summary>
    /// Keeps what's there before an action throws it away: the snapshot holding it (the one taken now, or the newest when
    /// nothing changed since, which holds the same), for that action's Undo. Null over SSH: local refs can't keep files
    /// on another computer, and the action stays available there without Undo.
    /// </summary>
    internal static string? Before(string root, string reason, GitRunner git) =>
        git is LocalGitRunner ? Take(root, reason, git)?.Id ?? (List(root, git) is [var newest, ..] ? newest.Id : null) : null;

    public static Snapshot? Take(string root, string reason, GitRunner git)
    {
        RequireLocal(git);
        root = git.CheckRoot(root);
        if (!SnapshotReasons.All.Contains(reason))
        {
            throw new ArgumentException("Unknown snapshot reason.");
        }
        lock (Gate)
        {
            return Capture(root, reason, git);
        }
    }

    private static Snapshot? Capture(string root, string reason, GitRunner git)
    {
        var index = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        var variables = new Dictionary<string, string> { [IndexVariable] = index };
        string Run(params string[] args) => Encoding.UTF8.GetString(git.WithInput(root, args, variables: variables)).Trim();
        try
        {
            var head = Head(root, git);
            Run("read-tree", head ?? "--empty");
            var captured = CaptureTree(root, head, git, variables);
            var tree = captured.Tree;
            var skipped = captured.Skipped;
            var previous = List(root, git);
            if (previous.Count > 0 && tree == GitView.Text(git, root, GitCommands.RevParse, previous[0].Id + "^{tree}").Trim())
            {
                return null;
            }
            var branch = GitView.Text(git, root, GitCommands.Branch, GitCommands.Options.ShowCurrent).Trim();
            var metadata = new SnapshotMetadata(reason, branch.Length == 0 ? null : branch, skipped.Count, skipped.ToList());
            var args = new List<string> { GitCommands.ConfigOption, "user.name=Termilly", GitCommands.ConfigOption, "user.email=history@termilly.local", "commit-tree", tree };
            if (head is not null)
            {
                args.AddRange([GitCommands.Parent, head]);
            }
            var hash = Encoding.UTF8.GetString(git.WithInput(root, args, JsonSerializer.Serialize(metadata))).Trim();
            var at = DateTimeOffset.UtcNow;
            var id = Namespace(root) + at.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            while (previous.Any(s => s.Id == id))
            {
                at = at.AddMilliseconds(1);
                id = Namespace(root) + at.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture);
            }
            git.Run(root, [GitCommands.UpdateRef, id, hash]);
            Expire(root, git, previous, at);
            return Read(root, id, git);
        }
        finally
        {
            File.Delete(index);
            File.Delete(index + ".lock");
        }
    }

    private sealed record CapturedTree(string Tree, IReadOnlyList<string> Skipped);

    private static CapturedTree CaptureTree(string root, string? head, GitRunner git, IReadOnlyDictionary<string, string> variables)
    {
        var paths = GitView.Text(git, root, GitCommands.ListFiles, GitCommands.Cached, OtherFiles, ExcludeIgnored, GitCommands.Options.NulTerminated)
            .Split('\0', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
        if (head is not null)
        {
            paths.UnionWith(GitView.Text(git, root, GitCommands.ListTree, GitCommands.Recursive, GitCommands.NameOnly, GitCommands.Options.NulTerminated, head)
                .Split('\0', StringSplitOptions.RemoveEmptyEntries));
        }
        var skipped = paths.Where(p => new FileInfo(Path.Combine(root, git.CheckPath(root, p))).LengthOrZero() > MaxFileBytes).ToHashSet(StringComparer.Ordinal);
        var included = paths.Where(p => !skipped.Contains(p)).ToList();
        if (included.Count > 0)
        {
            git.WithInput(root, [GitCommands.Add, "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], string.Join('\0', included) + '\0', variables);
        }
        var tree = Encoding.UTF8.GetString(git.WithInput(root, ["write-tree"], variables: variables)).Trim();
        return new CapturedTree(tree, skipped.ToList());
    }

    private static void Expire(string root, GitRunner git, IReadOnlyList<Snapshot> previous, DateTimeOffset now)
    {
        foreach (var item in previous.Where((s, i) => i >= MaxSnapshots - 1 || DateTimeOffset.Parse(s.At, CultureInfo.InvariantCulture) < now.AddDays(-RetentionDays)))
        {
            git.Run(root, [GitCommands.UpdateRef, GitCommands.DeleteRef, item.Id]);
        }
    }

    internal static string? Head(string root, GitRunner git)
    {
        try
        {
            return GitView.Text(git, root, GitCommands.RevParse, GitCommands.Verify, GitCommands.Head).Trim();
        }
        catch (GitFailedException)
        {
            return null; // An unborn branch has no parent for its first snapshot.
        }
    }

    /// <summary>
    /// This worktree's snapshots, newest first; with <paramref name="removed"/>, also those kept from worktrees removed
    /// with changes in them (their own folder is gone, so they're put back here or nowhere).
    /// </summary>
    public static IReadOnlyList<Snapshot> List(string root, GitRunner git, bool removed = false)
    {
        RequireLocal(git);
        var own = Namespace(root);
        var ids = Ids(root, git, removed ? Prefix : own);
        return ids.Select(id => Read(root, id, git))
            .Where(s => s.Id.StartsWith(own, StringComparison.Ordinal) || s.Reason == SnapshotReasons.BeforeRemove)
            .OrderByDescending(s => s.At, StringComparer.Ordinal).ToList();
    }

    private static string[] Ids(string root, GitRunner git, string prefix) =>
        GitView.Text(git, root, GitCommands.ForEachRef, "--format=%(refname)", prefix)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    private static Snapshot Read(string root, string id, GitRunner git)
    {
        var metadata = JsonSerializer.Deserialize<SnapshotMetadata>(GitView.Text(git, root, "show", GitCommands.Options.SizeOnly, "--format=%B", id))
            ?? throw new IOException("Invalid snapshot metadata.");
        var at = long.Parse(id[(id.LastIndexOf('/') + 1)..], CultureInfo.InvariantCulture);
        var files = GitOutput.CommitFiles(GitView.Text(git, root, "diff-tree", GitCommands.RootCommit, GitCommands.Recursive, GitCommands.Options.NulTerminated, "--name-status", "--no-commit-id", id), "")
            .Select(f => new GitFile(f.Path, f.OldPath, f.Status)).ToList();
        return new Snapshot(id, DateTimeOffset.FromUnixTimeMilliseconds(at).ToString("O", CultureInfo.InvariantCulture), metadata.Reason, metadata.Branch, files, metadata.Skipped);
    }

    public static SnapshotRestoreResult Restore(string root, string? id, IReadOnlyList<string>? paths, GitRunner git)
    {
        RequireLocal(git);
        lock (Gate)
        {
            var snapshot = List(root, git, removed: true).FirstOrDefault(s => s.Id == id) ?? throw new ArgumentException("That snapshot isn't in this worktree.");
            var revision = GitView.Text(git, root, GitCommands.RevParse, snapshot.Id).Trim();
            var tree = GitView.Text(git, root, GitCommands.ListTree, GitCommands.Recursive, GitCommands.NameOnly, GitCommands.Options.NulTerminated, snapshot.Id).Split('\0', StringSplitOptions.RemoveEmptyEntries).ToHashSet(StringComparer.Ordinal);
            var available = tree.Union(snapshot.Files.Select(f => f.Path)).ToHashSet(StringComparer.Ordinal);
            var metadata = JsonSerializer.Deserialize<SnapshotMetadata>(GitView.Text(git, root, GitCommands.Show, GitCommands.Options.SizeOnly, "--format=%B", snapshot.Id))!;
            var ignored = (metadata.SkippedPaths ?? []).ToHashSet(StringComparer.Ordinal);
            var current = GitView.Text(git, root, GitCommands.ListFiles, GitCommands.Cached, OtherFiles, ExcludeIgnored, GitCommands.Options.NulTerminated)
                .Split('\0', StringSplitOptions.RemoveEmptyEntries);
            var selected = paths ?? available.Union(current).Where(p => !ignored.Contains(p)).ToList();
            foreach (var path in selected)
            {
                git.CheckPath(root, path);
                // Undo of a restore puts back a file's absence too: one the snapshot before restoring didn't have goes.
                var absenceAllowed = metadata.Reason == SnapshotReasons.BeforeRestore;
                if (paths is not null && ((!available.Contains(path) && !absenceAllowed) || ignored.Contains(path)))
                {
                    throw new ArgumentException("That file isn't in the snapshot.");
                }
                CheckFile(root, path);
            }
            var before = Take(root, SnapshotReasons.BeforeRestore, git);
            foreach (var path in selected)
            {
                var full = Path.Combine(root, path);
                if (tree.Contains(path))
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(full)!);
                    AppPaths.WriteAtomically(full, git.Run(root, [GitCommands.CatFile, "--filters", revision + ":" + path]));
                }
                else
                {
                    File.Delete(full);
                }
            }
            var saved = List(root, git);
            return new SnapshotRestoreResult(before?.Id ?? (saved.Count > 0 ? saved[0].Id : null));
        }
    }

    internal static void CheckFile(string root, string path)
    {
        var full = Path.GetFullPath(Path.Combine(root, path));
        while (!string.Equals(full, root, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            if ((File.Exists(full) || Directory.Exists(full)) && File.GetAttributes(full).HasFlag(FileAttributes.ReparsePoint))
            {
                throw new IOException("Local history cannot write through a symbolic link.");
            }
            full = Path.GetDirectoryName(full)!;
        }
    }

    private static long LengthOrZero(this FileInfo file) => file.Exists ? file.Length : 0;
}
