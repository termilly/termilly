using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Enumeration;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A file or folder a search found: the folder it's in (its full path) and what it is.</summary>
internal sealed record FoundEntry(string Dir, FolderEntry Entry);

/// <summary>
/// The Files panel's search (js/filepanel.js): everything named so in a folder and all the folders in it, here or on
/// a server. A name matches when it holds the text, case aside, or, with * or ? in the text, matches it as a pattern.
/// It stops at <see cref="Most"/> found, skips what can't be read, and stops when it's cancelled (a new search).
/// </summary>
internal sealed class FileSearch(IProcessRunner runner)
{
    /// <summary>How many it finds before it stops.</summary>
    public const int Most = 1000;
    private const string ModifiedFormat = "yyyy-MM-dd HH:mm";
    /// <summary>How often what's found so far goes to the page, while a search here runs.</summary>
    private static readonly TimeSpan BatchEvery = TimeSpan.FromMilliseconds(150);
    private static readonly TimeSpan ServerTimeout = TimeSpan.FromMinutes(5);
    /// <summary>The server's answer when the folder can't be read.</summary>
    private const string FailedMark = "!";
    /// <summary>A match's line: type, size, modified, then its path (last, so a tab in a name stays in it).</summary>
    private const int LineFields = 4;
    private const int PathField = LineFields - 1;

    /// <summary>
    /// The server's side: the folder's full path, then a line per match (type, size, modified, full path), at most
    /// <see cref="Most"/> + 1. GNU find says it all itself; another (busybox) gives the paths, and a test the type.
    /// </summary>
    private const string Script = """
        p=$2
        case $p in "~") p=$HOME;; "~/"*) p=$HOME/${p#\~/};; esac
        cd "$p" 2>/dev/null || { echo "!"; exit 0; }
        pwd
        if find . -maxdepth 0 -printf '' >/dev/null 2>&1; then
          find "$PWD" -mindepth 1 -iname "$1" -printf '%y\t%s\t%TY-%Tm-%Td %TH:%TM\t%p\n' 2>/dev/null
        else
          find "$PWD" -mindepth 1 -iname "$1" 2>/dev/null | while IFS= read -r f; do
            if [ -d "$f" ]; then printf 'd\t0\t\t%s\n' "$f"; else printf 'f\t0\t\t%s\n' "$f"; fi
          done
        fi | head -n 1001
        """;

    /// <summary>Whether a name is one the search looks for.</summary>
    public static bool Matches(ReadOnlySpan<char> name, string text) =>
        text.AsSpan().IndexOfAny('*', '?') >= 0
            ? FileSystemName.MatchesSimpleExpression(text, name, ignoreCase: true)
            : name.Contains(text, StringComparison.OrdinalIgnoreCase);

    /// <summary>
    /// Searches a folder on this machine (FolderPaths.Drives: every drive), handing what it finds to
    /// <paramref name="found"/> a batch at a time. Returns whether it stopped at <see cref="Most"/>.
    /// </summary>
    public static bool Here(string folder, string text, Action<IReadOnlyList<FoundEntry>> found, CancellationToken cancel)
    {
        var roots = folder == Messaging.FolderPaths.Drives
            ? DriveInfo.GetDrives().Where(d => d.IsReady).Select(d => d.Name).ToList()
            : [LocalFiles.List(folder).Path];
        // Links and junctions aren't followed: they'd find the same files twice, or go round for ever.
        var options = new EnumerationOptions
        {
            IgnoreInaccessible = true, RecurseSubdirectories = true, AttributesToSkip = FileAttributes.System | FileAttributes.ReparsePoint,
        };
        var batch = new List<FoundEntry>();
        var count = 0;
        var clock = Stopwatch.StartNew();
        foreach (var root in roots)
        {
            var entries = new FileSystemEnumerable<FoundEntry>(root, (ref FileSystemEntry e) => new FoundEntry(e.Directory.ToString(),
                new FolderEntry(e.FileName.ToString(), e.IsDirectory, e.IsDirectory ? 0 : e.Length,
                    e.LastWriteTimeUtc.ToLocalTime().ToString(ModifiedFormat, CultureInfo.InvariantCulture), "")), options)
            {
                ShouldIncludePredicate = (ref FileSystemEntry e) => Matches(e.FileName, text),
            };
            foreach (var entry in entries)
            {
                cancel.ThrowIfCancellationRequested();
                if (++count > Most)
                {
                    found(batch);
                    return true;
                }
                batch.Add(entry);
                if (clock.Elapsed >= BatchEvery)
                {
                    found(batch);
                    batch = [];
                    clock.Restart();
                }
            }
        }
        found(batch);
        return false;
    }

    /// <summary>Searches a folder on a server, in one ssh call; what it found, and whether it stopped at <see cref="Most"/>.</summary>
    public (List<FoundEntry> Found, bool Stopped) OnServer(FileServer server, string folder, string text, CancellationToken cancel)
    {
        var pattern = text.AsSpan().IndexOfAny('*', '?') >= 0 ? text : $"*{text}*";
        var result = runner.RunAsync(FolderTree.ScriptRequest(server, Script, [pattern, folder], ServerTimeout), cancel).GetAwaiter().GetResult();
        return Parse(FolderTree.Succeeded(result), folder);
    }

    /// <summary>The server's answer (<see cref="Script"/>): what it found, and whether there was more.</summary>
    public static (List<FoundEntry> Found, bool Stopped) Parse(string output, string folder)
    {
        var lines = output.Split('\n').Select(l => l.TrimEnd('\r')).Where(l => l.Length > 0).ToList();
        if (lines.Count == 0 || lines[0] == FailedMark)
        {
            throw new IOException($"{folder} can't be read.");
        }
        var found = new List<FoundEntry>();
        foreach (var line in lines.Skip(1))
        {
            var parts = line.Split('\t', LineFields);
            var slash = parts.Length == LineFields ? parts[PathField].LastIndexOf('/') : -1;
            if (slash < 0)
            {
                continue;
            }
            var path = parts[PathField];
            var dir = slash == 0 ? "/" : path[..slash];
            _ = long.TryParse(parts[1], NumberStyles.Integer, CultureInfo.InvariantCulture, out var size);
            var isDirectory = parts[0] == "d";
            found.Add(new FoundEntry(dir, new FolderEntry(path[(slash + 1)..], isDirectory, isDirectory ? 0 : size, parts[2], "")));
        }
        var stopped = found.Count > Most;
        return (stopped ? found[..Most] : found, stopped);
    }
}
