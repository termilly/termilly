using System.Collections.Concurrent;
using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A repository's state for the sidebar: branch, changed files, ahead and behind its upstream, last commit.</summary>
internal sealed record GitState(string Root, string? Branch, bool Detached, int Changed, int Ahead, int Behind, string? Upstream, string? LastCommit);

/// <summary>A folder the sidebar shows and the repository it's in (null when it isn't in one).</summary>
internal sealed record GitFolderState(string Folder, GitState? State);

/// <summary>
/// Project status in the sidebar (js/gitstatus.js): what <c>git status --porcelain=v2 --branch</c> says about the
/// repository a folder is in. Cached per repository for a few seconds, so many terminals in one repo cost one
/// git run, and only folders the page asks about (visible workspaces) are looked at.
/// </summary>
internal sealed class GitStatus(LocalGit git)
{
    /// <summary>The most folders the sidebar asks about at once.</summary>
    public const int MaxFolders = 40;

    private static readonly TimeSpan Fresh = TimeSpan.FromSeconds(4);
    private static readonly string[] StatusCommand =
        [GitCommands.Options.NoOptionalLocks, GitCommands.Status, GitCommands.Options.PorcelainV2, GitCommands.Options.WithBranch, "--untracked-files=normal"];
    private static readonly string[] LastCommitCommand = [GitCommands.Log, "-1", "--format=%h %s"];
    private readonly ConcurrentDictionary<string, (DateTime At, GitState? State)> _cache = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>The repository root a folder is in (where .git is), or null outside a repository.</summary>
    public static string? RootOf(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder))
        {
            return null;
        }
        try
        {
            for (var dir = new DirectoryInfo(folder); dir is not null; dir = dir.Parent)
            {
                var dotGit = Path.Combine(dir.FullName, GitCommands.DotGit);
                if (Directory.Exists(dotGit) || File.Exists(dotGit))
                {
                    return dir.FullName;
                }
            }
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or System.Security.SecurityException)
        {
            // An odd path: no repository.
        }
        return null;
    }

    /// <summary>The state of the repository a folder is in (cached a few seconds unless <paramref name="force"/>), or null.</summary>
    public GitState? Of(string? folder, bool force = false)
    {
        if (RootOf(folder) is not { } root)
        {
            return null;
        }
        if (!force && _cache.TryGetValue(root, out var cached) && DateTime.UtcNow - cached.At < Fresh)
        {
            return cached.State;
        }
        GitState? state;
        try
        {
            var porcelain = git.Text(root, StatusCommand);
            string? last = null;
            try
            {
                last = git.Text(root, LastCommitCommand);
            }
            catch (IOException)
            {
                // A repository without commits yet.
            }
            state = Parse(root, porcelain, last);
        }
        catch (IOException)
        {
            state = null; // git missing, or the folder isn't readable
        }
        _cache[root] = (DateTime.UtcNow, state);
        return state;
    }

    /// <summary>Reads <c>git status --porcelain=v2 --branch</c> output.</summary>
    public static GitState Parse(string root, string porcelain, string? lastCommit)
    {
        var header = new GitOutput.StatusHeader();
        var changed = 0;
        foreach (var raw in porcelain.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (!header.Read(line) && GitOutput.IsFileEntry(line))
            {
                changed++;
            }
        }
        return new GitState(root, header.ShownBranch, header.Detached, changed, header.Ahead, header.Behind, header.Upstream,
            string.IsNullOrWhiteSpace(lastCommit) ? null : lastCommit);
    }
}
