using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>A file in the Git window's Changes tab: its path, its old path when renamed, and a status letter.</summary>
internal sealed record GitFile(string Path, string? OldPath, string Status);

/// <summary>What the Git window's Changes tab lists (js/gitwindow.js).</summary>
internal sealed record GitWorkingTree(
    string Root, string Name, string? Branch, bool Detached, string? Upstream, int Ahead, int Behind, bool HasCommits,
    IReadOnlyList<GitFile> Staged, IReadOnlyList<GitFile> Unstaged, IReadOnlyList<GitFile> Untracked, IReadOnlyList<GitFile> Conflicted);

/// <summary>A commit in the History tab.</summary>
internal sealed record GitCommit(string Hash, string Short, IReadOnlyList<string> Parents, string Author, string Date, string Subject, IReadOnlyList<string> Refs);

/// <summary>A file a commit changed, with its line counts (null for a binary file).</summary>
internal sealed record GitCommitFile(string Path, string? OldPath, string Status, int? Added, int? Removed);

/// <summary>One commit in full: its message, who wrote and committed it, and the files it changed.</summary>
internal sealed record GitCommitDetail(
    string Hash, IReadOnlyList<string> Parents, string Author, string AuthorDate, string Committer, string CommitDate, string Message,
    IReadOnlyList<GitCommitFile> Files);

/// <summary>
/// Which change of a file to show: its path (and its old path when renamed), the side (one of <see cref="DiffSides"/>)
/// and, for a commit, its hash.
/// </summary>
internal sealed record GitDiffTarget(string Path, string? OldPath, string Side, string? Hash = null);

/// <summary>A Git window action's answer when it worked (a failure answers with git's error instead).</summary>
internal sealed record GitActionDone(bool Ok);

/// <summary>A branch in the Branches tab.</summary>
internal sealed record GitBranchInfo(
    string Ref, string Name, bool Remote, bool Current, string Short, string? Upstream, int Ahead, int Behind, bool Gone, string Date, string Subject);

/// <summary>
/// The Git window (js/gitwindow.js): a repository's working tree, any file's diff (staged, unstaged, untracked or in
/// a commit), its history and its branches. Read only. Everything the page sends is checked: the folder must be a
/// repository's root, paths must stay inside it, hashes look like hashes and refs must be ones git listed, so
/// nothing from the page reaches git as an option. git runs without a pager, prompts or optional locks, with a
/// timeout, off the UI thread (the caller's job). It runs where the <see cref="GitRunner"/> says: on this PC, or on
/// the server an SSH terminal works on.
/// </summary>
internal static partial class GitView
{
    [GeneratedRegex("^[0-9a-f]{4,64}$")]
    private static partial Regex HashPattern();

    /// <summary>The most commits one page of history asks for.</summary>
    private const int MaxLog = 500;
    /// <summary>git's message for a log of a repository without commits: an empty history.</summary>
    private const string NoCommits = "does not have any commits";
    private const long BytesPerKb = 1024;
    /// <summary>A log's branch and tag names in full (GitOutput.ShortRef shortens them).</summary>
    internal const string FullDecorations = "--decorate=full";

    internal static readonly string[] StatusCommand = [GitCommands.Status, GitCommands.Options.PorcelainV2, GitCommands.Options.NulTerminated, GitCommands.Options.WithBranch, "--untracked-files=all"];
    /// <summary>A commit's files, renames found, against <c>range</c>: their status letters, or their line counts.</summary>
    private static readonly string[] CommitNames = [GitCommands.DiffTree, "-r", GitCommands.Options.NulTerminated, "-M", "--name-status", "--no-commit-id"];
    private static readonly string[] CommitCounts = [GitCommands.DiffTree, "-r", GitCommands.Options.NulTerminated, "-M", "--numstat", "--no-commit-id"];
    private static readonly string[] BranchRefs = [GitCommands.Refs.Heads, GitCommands.Refs.Remotes];

    // ---- Checking what the page sends ----

    public static bool LooksLikeHash(string text) => HashPattern().IsMatch(text);

    public static string CheckHash(string? hash) =>
        hash is not null && HashPattern().IsMatch(hash) ? hash : throw new ArgumentException("That isn't a commit.");

    internal static string Text(GitRunner git, string root, params string[] args) => Encoding.UTF8.GetString(git.Run(root, args));

    // ---- Changes ----

    public static GitWorkingTree Status(string folder, GitRunner git)
    {
        var root = git.RootOf(folder) ?? throw new ArgumentException("Not in a git repository.");
        var raw = Text(git, root, StatusCommand);
        return GitOutput.Status(root, raw);
    }

    // ---- Diffs ----

    /// <summary>
    /// A file's diff in the change preview's shape: staged (last commit against the index), unstaged (index against
    /// the disk), untracked (the new file) or in a commit (its first parent against it).
    /// </summary>
    public static ChangeView Diff(string root, GitDiffTarget target, long maxBytes, GitRunner git)
    {
        var path = git.CheckPath(root, target.Path);
        var from = target.OldPath is null ? path : git.CheckPath(root, target.OldPath);
        var hash = target.Hash;
        Blob before, after;
        switch (target.Side)
        {
            case DiffSides.Staged:
                before = Object(git, root, GitCommands.Object(GitCommands.Head, from), maxBytes);
                after = Object(git, root, GitCommands.Object(Index, path), maxBytes);
                break;
            case DiffSides.Unstaged:
                before = Object(git, root, GitCommands.Object(Index, path), maxBytes);
                if (!before.Exists)
                {
                    before = Object(git, root, GitCommands.Object(GitCommands.Head, path), maxBytes);
                }
                after = git.ReadFile(root, path, maxBytes);
                break;
            case DiffSides.Untracked:
                before = Blob.Missing;
                after = git.ReadFile(root, path, maxBytes);
                break;
            case DiffSides.Commit:
                hash = CheckHash(hash);
                var parent = Parents(git, root, hash).FirstOrDefault();
                before = parent is null ? Blob.Missing : Object(git, root, GitCommands.Object(parent, from), maxBytes);
                after = Object(git, root, GitCommands.Object(hash, path), maxBytes);
                break;
            default:
                throw new ArgumentException("Unknown kind of change.");
        }
        return View(path, target.OldPath is null ? path : $"{from} → {path}", before, after);
    }

    /// <summary>The index, as a revision in a blob's name (":path").</summary>
    private const string Index = "";

    private static ChangeView View(string path, string display, Blob before, Blob after)
    {
        var kind = !before.Exists ? ChangeKinds.Created : !after.Exists ? ChangeKinds.Deleted : ChangeKinds.Modified;
        if (!before.Exists && !after.Exists)
        {
            return new ChangeView(path, display, ChangeKinds.Missing, null, null, [], 0, 0, false, 0, 0, 0, ChangeSources.Git, null, "The file isn't there.");
        }
        string? note = null;
        if (before.Binary || after.Binary)
        {
            note = "A binary file: there are no lines to compare.";
        }
        else if (before.TooLarge || after.TooLarge)
        {
            note = $"Too large to show ({Math.Max(before.Size, after.Size) / BytesPerKb:N0} KB).";
        }
        var beforeText = before.Text();
        var afterText = after.Text();
        LineDiff.Result? diff = beforeText is not null || afterText is not null ? LineDiff.Diff(beforeText ?? "", afterText ?? "") : null;
        return new ChangeView(path, display, kind,
            before.Exists ? beforeText : null, after.Exists ? afterText : null,
            diff?.Runs.Select(r => new[] { r.Kind, r.Count }).ToList() ?? [],
            diff?.Added ?? 0, diff?.Removed ?? 0, diff?.EolOnly ?? false, before.Size, after.Size, 0, ChangeSources.Git, note, null);
    }

    /// <summary>A blob by git's rev:path name, size checked first so a huge file isn't read; missing when it isn't there.</summary>
    private static Blob Object(GitRunner git, string root, string name, long maxBytes)
    {
        long size;
        try
        {
            size = long.Parse(Text(git, root, GitCommands.CatFile, GitCommands.Options.SizeOnly, name).Trim(), System.Globalization.CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (e is IOException or FormatException)
        {
            return Blob.Missing;
        }
        if (size > maxBytes)
        {
            return new Blob(true, null, false, true, size);
        }
        return Blob.From(git.Run(root, [GitCommands.CatFile, "blob", name]), maxBytes);
    }

    private static string[] Parents(GitRunner git, string root, string hash)
    {
        var line = Text(git, root, GitCommands.RevList, "--parents", "-n", "1", hash).Trim();
        return line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Skip(1).ToArray();
    }

    // ---- History ----

    /// <summary>Commits, newest first, from HEAD or from one of the repository's refs.</summary>
    public static IReadOnlyList<GitCommit> Log(string root, int skip, int limit, string? reference, GitRunner git)
    {
        var args = new List<string> { GitCommands.Log, GitOutput.LogFormat, FullDecorations,
            $"--skip={Math.Max(0, skip)}", $"-n{Math.Clamp(limit, 1, MaxLog)}" };
        if (reference is not null)
        {
            // Only a ref git itself listed, and after --end-of-options so it can't be taken for an option.
            if (!RefNames(git, root).Contains(reference))
            {
                throw new ArgumentException("That branch isn't in the repository.");
            }
            args.Add(GitCommands.Options.EndOfOptions);
            args.Add(reference);
        }
        return ReadLog(git, root, args);
    }

    /// <summary>git log's commits; none for a repository without commits.</summary>
    internal static IReadOnlyList<GitCommit> ReadLog(GitRunner git, string root, IReadOnlyList<string> args)
    {
        try
        {
            return GitOutput.Log(Text(git, root, [.. args]));
        }
        catch (IOException e) when (e.Message.Contains(NoCommits, StringComparison.OrdinalIgnoreCase))
        {
            return [];
        }
    }

    /// <summary>The commit whose hash starts with this; null when none does, or more than one.</summary>
    internal static GitCommit? FindCommit(GitRunner git, string root, string hash)
    {
        try
        {
            var full = Text(git, root, GitCommands.RevParse, "--verify", GitCommands.Options.Quiet, $"{hash}^{{commit}}").Trim();
            var found = GitOutput.Log(Text(git, root, GitCommands.Log, GitOutput.LogFormat, FullDecorations, "-n1", CheckHash(full)));
            return found.Count > 0 ? found[0] : null;
        }
        catch (IOException)
        {
            return null;
        }
    }

    public static GitCommitDetail Commit(string root, string hash, GitRunner git)
    {
        hash = CheckHash(hash);
        var head = GitOutput.CommitHead(Text(git, root, GitCommands.Show, GitCommands.Options.SizeOnly, GitOutput.CommitFormat, GitCommands.Options.EndOfOptions, hash));
        // Against the first parent (a merge's changes as the branch received them); the first commit against nothing.
        string[] range = head.Parents.Count > 0 ? [head.Parents[0], head.Hash] : ["--root", head.Hash];
        var status = git.Run(root, [.. CommitNames, .. range]);
        var numstat = git.Run(root, [.. CommitCounts, .. range]);
        return head with { Files = GitOutput.CommitFiles(Encoding.UTF8.GetString(status), Encoding.UTF8.GetString(numstat)) };
    }

    // ---- Actions ----

    /// <summary>
    /// Changes the repository, for the Git window's menus:
    /// <list type="bullet">
    /// <item>stage: <c>git add</c> a changed or untracked file, or a resolved conflict;</item>
    /// <item>unstage: take a staged file out of the next commit (its changes stay on disk);</item>
    /// <item>discard: undo a file's changes on disk (back to what's staged, or the last commit);</item>
    /// <item>discard-all: undo a staged file's changes, staged and on disk, back to the last commit;</item>
    /// <item>delete: remove an untracked file (<c>git clean</c>, so nothing git tracks or ignores);</item>
    /// <item>ignore: add the file to the repository's .gitignore;</item>
    /// <item>switch: check out a branch git listed; a remote one as a new local branch that tracks it.</item>
    /// </list>
    /// git's own refusals (changes a switch would overwrite, a branch that already exists) come back as they are.
    /// </summary>
    public static void Act(string root, string action, string? path, string? reference, bool hasCommits, GitRunner git)
    {
        if (action == GitActions.Switch)
        {
            SwitchTo(root, reference, git);
            return;
        }
        var file = git.CheckPath(root, path);
        if (action == GitActions.Ignore)
        {
            git.AppendLine(root, GitCommands.GitIgnore, "/" + file);
            return;
        }
        string[] args = action switch
        {
            GitActions.Stage => [GitCommands.Add, GitCommands.Options.Paths, file],
            // Before the first commit there's no HEAD to go back to: the file just leaves the index.
            GitActions.Unstage => hasCommits ? [GitCommands.Restore, GitCommands.Options.Staged, GitCommands.Options.Paths, file] : [GitCommands.Remove, "--cached", GitCommands.Options.Quiet, GitCommands.Options.Paths, file],
            GitActions.Discard => [GitCommands.Restore, GitCommands.Options.Paths, file],
            GitActions.DiscardAll => [GitCommands.Restore, GitCommands.Options.Staged, "--worktree", $"--source={GitCommands.Head}", GitCommands.Options.Paths, file],
            GitActions.Delete => [GitCommands.Clean, "-f", GitCommands.Options.Quiet, GitCommands.Options.Paths, file],
            _ => throw new ArgumentException("Unknown action."),
        };
        git.Run(root, args);
    }

    /// <summary>Checks out a branch git listed; a remote one as a new local branch that tracks it.</summary>
    private static void SwitchTo(string root, string? reference, GitRunner git)
    {
        if (reference is null || !RefNames(git, root).Contains(reference) ||
            !(reference.StartsWith(GitCommands.Refs.HeadsPrefix, StringComparison.Ordinal) || reference.StartsWith(GitCommands.Refs.RemotesPrefix, StringComparison.Ordinal)))
        {
            throw new ArgumentException("That branch isn't in the repository.");
        }
        git.Run(root, reference.StartsWith(GitCommands.Refs.HeadsPrefix, StringComparison.Ordinal)
            ? [GitCommands.Switch, GitCommands.Options.EndOfOptions, reference[GitCommands.Refs.HeadsPrefix.Length..]]
            : [GitCommands.Switch, "--track", GitCommands.Options.EndOfOptions, reference[GitCommands.Refs.RemotesPrefix.Length..]]);
    }

    // ---- Branches ----

    private static HashSet<string> RefNames(GitRunner git, string root) =>
        Text(git, root, [GitCommands.ForEachRef, "--format=%(refname)", .. BranchRefs, GitCommands.Refs.Tags])
            .Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries).ToHashSet(StringComparer.Ordinal);

    public static IReadOnlyList<GitBranchInfo> Branches(string root, GitRunner git)
    {
        var raw = Text(git, root, [GitCommands.ForEachRef, GitOutput.BranchFormat, "--sort=-committerdate", .. BranchRefs]);
        return GitOutput.Branches(raw);
    }
}
