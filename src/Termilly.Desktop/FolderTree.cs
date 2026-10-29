using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A folder in "Copy to"'s tree: its name (a drive's root, with its label), and whether it has folders in it.</summary>
internal sealed record TreeFolder(string Name, bool HasFolders, string? Label = null);

/// <summary>
/// The folders of one folder for "Copy to"'s tree (js/copyto.js): Path as asked, Full its full path, and its folders,
/// or Error when it can't be read.
/// </summary>
internal sealed record TreeBranch(string Path, string? Full, IReadOnlyList<TreeFolder> Folders, string? Error = null);

/// <summary>
/// "Copy to"'s folder tree: the folders in each of several folders, and for each whether it has folders of its own
/// (its "+"), here or on a server. Several at once, so a tree opened down to a deep folder costs one ssh call.
/// </summary>
internal sealed class FolderTree(IProcessRunner runner)
{
    private static readonly TimeSpan ServerTimeout = TimeSpan.FromMinutes(1);
    /// <summary>The line that starts each folder's part of the server's answer, then its number.</summary>
    private const string BranchMark = "@@";
    /// <summary>The line after it when the folder can't be read.</summary>
    private const string FailedMark = "!";

    /// <summary>
    /// The server's side: for each folder given ("~" and "~/x" in the home folder), a mark line, its full path, then a
    /// line per folder in it, "1" or "0" (whether that has folders), a tab and its name. Links to folders count.
    /// </summary>
    private const string Script = """
        i=0
        for p in "$@"; do
          echo "@@$i"; i=$((i+1))
          case $p in "~") p=$HOME;; "~/"*) p=$HOME/${p#\~/};; esac
          cd "$p" 2>/dev/null || { echo "!"; continue; }
          pwd
          for d in * .*; do
            case $d in .|..) continue;; esac
            [ -d "$d" ] || continue
            has=0
            for s in "$d"/* "$d"/.*; do
              case ${s##*/} in .|..) continue;; esac
              [ -d "$s" ] && { has=1; break; }
            done
            printf '%s\t%s\n' "$has" "$d"
          done
        done
        """;

    /// <summary>The folders in each of <paramref name="paths"/> on this machine (FolderPaths.Drives: the drives).</summary>
    public static List<TreeBranch> Here(IReadOnlyList<string> paths) => paths.Select(Here).ToList();

    private static TreeBranch Here(string path)
    {
        if (path == Messaging.FolderPaths.Drives)
        {
            var drives = DriveInfo.GetDrives().Where(d => d.IsReady)
                .Select(d => new TreeFolder(d.Name, true, LocalFiles.DriveLabel(d))).ToList();
            return new(path, path, drives);
        }
        try
        {
            var listing = LocalFiles.List(path);
            var folders = listing.Entries.Where(e => e.IsDirectory)
                .Select(e => new TreeFolder(e.Name, HasFolders(Path.Combine(listing.Path, e.Name)))).ToList();
            return new(path, listing.Path, folders);
        }
        catch (IOException e)
        {
            return new(path, null, [], e.Message);
        }
    }

    /// <summary>Whether a folder has folders in it (one it can't read has none, as far as anyone here can tell).</summary>
    private static bool HasFolders(string folder)
    {
        try
        {
            return Directory.EnumerateDirectories(folder, "*", LocalFiles.ListOptions).Any();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>The folders in each of <paramref name="paths"/> on a server, in one ssh call.</summary>
    public List<TreeBranch> OnServer(FileServer server, IReadOnlyList<string> paths)
    {
        // The script's lines end as this file's do (CRLF in a Windows checkout): sh would read "do\r" as a word.
        var script = Script.Replace("\r", "", StringComparison.Ordinal);
        var command = $"sh -c {SshGitRunner.Quote(script)} sh {string.Join(' ', paths.Select(SshGitRunner.Quote))}";
        var result = runner.Run(new ProcessRequest(SessionProfiles.SshCommand, [])
        {
            CommandLine = $"-T -o BatchMode=yes -o ConnectTimeout=15 {server.Ssh} {SshGitRunner.QuoteArgument(command)}",
            Timeout = ServerTimeout,
        });
        if (!result.Succeeded)
        {
            throw new IOException(result.ErrorLines.LastOrDefault() ?? $"ssh failed ({result.ExitCode}).");
        }
        return Parse(result.Text, paths);
    }

    /// <summary>The server's answer (<see cref="Script"/>), folder by folder, folders by name.</summary>
    public static List<TreeBranch> Parse(string output, IReadOnlyList<string> paths)
    {
        var branches = paths.Select(p => new TreeBranch(p, null, [], $"{p} can't be read.")).ToList();
        var at = -1;
        string? full = null;
        var folders = new List<TreeFolder>();
        void Finish()
        {
            if (at >= 0 && at < branches.Count && full is not null)
            {
                branches[at] = new(paths[at], full, folders.OrderBy(f => f.Name, StringComparer.OrdinalIgnoreCase).ToList());
            }
        }
        foreach (var raw in output.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith(BranchMark, StringComparison.Ordinal) && int.TryParse(line[BranchMark.Length..], out var next))
            {
                Finish();
                (at, full, folders) = (next, null, []);
            }
            else if (at < 0 || line == FailedMark)
            {
                continue;
            }
            else if (full is null)
            {
                full = line;
            }
            else if (line.Length > 2 && line[1] == '\t')
            {
                folders.Add(new TreeFolder(line[2..], line[0] == '1'));
            }
        }
        Finish();
        return branches;
    }
}
