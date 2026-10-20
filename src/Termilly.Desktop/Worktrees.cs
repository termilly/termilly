using System.IO;
using System.IO.Enumeration;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A worktree made for an agent: where it is, its branch, and the repository it came from.</summary>
internal sealed record WorktreeInfo(string Repo, string Path, string Branch, int Copied);

/// <summary>Whether a worktree can go: merged into the branch it came from, and whether it has uncommitted work.</summary>
internal sealed record WorktreeStatus(string Branch, string Base, bool Merged, int Changes, bool Exists);

/// <summary>
/// "New agent in worktree": a branch and a git worktree next to the repository (repo.worktrees\branch), with the
/// files listed in .worktreeinclude copied in (.env and other untracked files the work needs), and cleanup once
/// it's merged or abandoned. Everything runs through git itself.
/// </summary>
internal sealed partial class Worktrees(LocalGit git)
{
    /// <summary>The folder next to the repository the worktrees go in: "repo.worktrees".</summary>
    private const string WorktreesSuffix = ".worktrees";
    /// <summary>The end git reserves for its lock files: not part of a branch name.</summary>
    private const string LockSuffix = ".lock";
    private const string RemoveWorktree = "remove";
    private const string ParentFolder = "..";
    /// <summary>What to copy into a new worktree, in the repository's root.</summary>
    private const string IncludeList = ".worktreeinclude";

    /// <summary>A branch name git accepts, from what was typed: spaces become dashes, odd characters go.</summary>
    public static string BranchName(string typed)
    {
        var name = BranchJunk().Replace(typed.Trim().Replace(' ', '-'), "");
        name = Regex.Replace(name, "-{2,}|/{2,}|\\.{2,}", m => m.Value[..1]).Trim('-', '/', '.');
        return name.EndsWith(LockSuffix, StringComparison.Ordinal) ? name[..^LockSuffix.Length] : name;
    }

    [GeneratedRegex(@"[^\w./-]")]
    private static partial Regex BranchJunk();

    /// <summary>Where a branch's worktree goes: next to the repository, in "repo.worktrees\feature-x".</summary>
    public static string PathFor(string repoRoot, string branch)
    {
        var root = repoRoot.TrimEnd('\\', '/');
        return System.IO.Path.Combine(System.IO.Path.GetDirectoryName(root) ?? root, System.IO.Path.GetFileName(root) + WorktreesSuffix, branch.Replace('/', '-'));
    }

    /// <summary>Creates the branch (from what the repository has checked out) and its worktree, and copies the included files.</summary>
    public WorktreeInfo Create(string folder, string typedBranch)
    {
        var repo = git.Text(folder, GitCommands.RevParse, GitCommands.Options.ShowTopLevel).Replace('/', '\\');
        var branch = BranchName(typedBranch);
        if (branch.Length == 0)
        {
            throw new IOException("That isn't a usable branch name.");
        }
        var path = PathFor(repo, branch);
        if (Directory.Exists(path))
        {
            throw new IOException($"{path} already exists.");
        }
        git.Text(repo, GitCommands.Worktree, GitCommands.Add, "-b", branch, path);
        var copied = CopyIncluded(repo, path);
        return new WorktreeInfo(repo, path, branch, copied);
    }

    /// <summary>
    /// Copies what .worktreeinclude lists (one path or wildcard pattern per line, relative to the repository; #
    /// comments) into the worktree, keeping folders. Files git tracks are already there and are left alone.
    /// </summary>
    public static int CopyIncluded(string repo, string worktree)
    {
        var list = System.IO.Path.Combine(repo, IncludeList);
        if (!File.Exists(list))
        {
            return 0;
        }
        var copied = 0;
        foreach (var relative in IncludedFiles(repo, File.ReadAllLines(list)))
        {
            var target = System.IO.Path.Combine(worktree, relative);
            if (File.Exists(target))
            {
                continue;
            }
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(target)!);
            File.Copy(System.IO.Path.Combine(repo, relative), target);
            copied++;
        }
        return copied;
    }

    /// <summary>The repository-relative files the patterns match (a folder means everything in it). .git is never included.</summary>
    public static IEnumerable<string> IncludedFiles(string repo, IEnumerable<string> patterns)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var raw in patterns)
        {
            var pattern = raw.Trim().Replace('/', '\\').TrimStart('\\');
            if (pattern.Length == 0 || pattern.StartsWith('#') || pattern.Split('\\').Contains(ParentFolder))
            {
                continue;
            }
            var full = System.IO.Path.Combine(repo, pattern.TrimEnd('\\'));
            IEnumerable<string> files;
            if (File.Exists(full))
            {
                files = [full];
            }
            else if (Directory.Exists(full))
            {
                files = Directory.EnumerateFiles(full, "*", SearchOption.AllDirectories);
            }
            else
            {
                // A wildcard: matched against every file's repository-relative path ("*.env" also matches in subfolders).
                // Matched with forward slashes: a backslash escapes the next character in these expressions.
                var expression = pattern.Replace('\\', '/');
                files = Directory.EnumerateFiles(repo, "*", SearchOption.AllDirectories).Where(f =>
                {
                    var rel = System.IO.Path.GetRelativePath(repo, f).Replace('\\', '/');
                    return FileSystemName.MatchesSimpleExpression(expression, rel) ||
                           (!expression.Contains('/') && FileSystemName.MatchesSimpleExpression(expression, System.IO.Path.GetFileName(f)));
                });
            }
            foreach (var file in files)
            {
                var rel = System.IO.Path.GetRelativePath(repo, file);
                if (!rel.Split('\\').Contains(GitCommands.DotGit) && seen.Add(rel))
                {
                    yield return rel;
                }
            }
        }
    }

    /// <summary>The worktree's branch, whether it's merged into the repository's checked-out branch, and uncommitted changes.</summary>
    public WorktreeStatus Status(string repo, string path, string branch)
    {
        var baseBranch = git.Text(repo, GitCommands.RevParse, "--abbrev-ref", GitCommands.Head);
        var merged = git.Text(repo, GitCommands.Branch, "--merged", baseBranch, "--format=%(refname:short)")
            .Split('\n').Select(l => l.Trim()).Contains(branch);
        if (!Directory.Exists(path))
        {
            return new WorktreeStatus(branch, baseBranch, merged, 0, false);
        }
        var changes = git.Text(path, GitCommands.Status, "--porcelain").Split('\n', StringSplitOptions.RemoveEmptyEntries).Length;
        return new WorktreeStatus(branch, baseBranch, merged, changes, true);
    }

    /// <summary>Removes the worktree (force: even with uncommitted changes) and, when asked, its branch.</summary>
    public void Remove(string repo, string path, string branch, bool deleteBranch, bool force)
    {
        if (Directory.Exists(path))
        {
            git.Text(repo, force ? [GitCommands.Worktree, RemoveWorktree, GitCommands.Options.Force, path] : [GitCommands.Worktree, RemoveWorktree, path]);
        }
        else
        {
            git.Text(repo, GitCommands.Worktree, "prune");
        }
        if (deleteBranch)
        {
            git.Text(repo, GitCommands.Branch, force ? "-D" : "-d", branch);
        }
        // The last worktree out takes "repo.worktrees" with it.
        var parent = System.IO.Path.GetDirectoryName(path.TrimEnd('\\'));
        if (parent is not null && parent.EndsWith(WorktreesSuffix, StringComparison.OrdinalIgnoreCase) &&
            Directory.Exists(parent) && !Directory.EnumerateFileSystemEntries(parent).Any())
        {
            Directory.Delete(parent);
        }
    }
}
