using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// While a shell command runs: the folders it may change (the ones it names, Claude's own, and those of the files
/// already on the list), what was in them at the start, copies of their small files, and what a watcher saw change.
/// Afterwards, <see cref="Changes"/> says which files the command made or changed.
/// </summary>
internal sealed class ShellWatch : IDisposable
{
    /// <summary>Copies taken before a command, kept small, as the hook waits for them.</summary>
    public const int MaxCopies = 500;
    public const long MaxCopyBytes = 16L << 20;
    /// <summary>The most folders watched for one command.</summary>
    private const int MaxFolders = 20;
    private const int WatcherBuffer = 64 * 1024;
    /// <summary>How long the watchers are given to catch up with a command's last writes in subfolders.</summary>
    private static readonly TimeSpan CatchUp = TimeSpan.FromMilliseconds(100);

    private readonly List<FileSystemWatcher> _watchers = [];
    /// <summary>Files directly in the watched folders at the start, and those copied below them: size and last write.</summary>
    private readonly Dictionary<string, (long Size, DateTime Write)> _before = new(ChangePaths.Comparer);
    private readonly List<string> _folders = [];
    /// <summary>Paths the watchers reported, with whether the first report was a new file.</summary>
    private readonly ConcurrentDictionary<string, bool> _touched = new(ChangePaths.Comparer);
    /// <summary>
    /// Folders the command names that didn't exist yet, as the first missing folder under one that did (d:\temp\proj
    /// for d:\temp\proj\sub$i): whatever is in them afterwards, the command made.
    /// </summary>
    private readonly List<string> _newRoots = [];
    /// <summary>Claude's folder, and the folders directly in it at the start: a folder new there was made by the command.</summary>
    private string? _home;
    private readonly HashSet<string> _homeDirs = new(ChangePaths.Comparer);

    public DateTime Started { get; } = DateTime.UtcNow;

    /// <summary>Commands in parallel share one watch: how many are still running.</summary>
    public int Running { get; set; } = 1;

    /// <summary>Copies of the small files in the watched folders, taken before the command ran.</summary>
    public Dictionary<string, Blob> Copies { get; } = new(ChangePaths.Comparer);

    /// <summary>Whether the file was there when the command started.</summary>
    public bool WasThere(string path) => _before.ContainsKey(path);

    /// <param name="named">The folders the command names, full.</param>
    /// <param name="claudes">Claude's folder, full; null when not known.</param>
    /// <param name="listed">The files already on the list: their folders are watched, but not copied again.</param>
    /// <param name="copy">Take copies (not in git mode).</param>
    public static ShellWatch Begin(IReadOnlyList<string> named, string? claudes, IEnumerable<string> listed, bool copy, CopyBudget budget)
    {
        var watch = new ShellWatch();
        // Claude's folder and the named ones are watched with their subfolders (a refactor touches files all over a
        // project), unless one is a whole drive or the profile; the folders of listed files only at their top.
        var cwd = claudes is not null && !ChangePaths.IsBroad(claudes) ? claudes : null;
        var deep = named.Append(cwd).OfType<string>().Where(f => !ChangePaths.IsBroad(f)).ToHashSet(ChangePaths.Comparer);
        var listedDirs = listed.Select(Path.GetDirectoryName).OfType<string>().ToList();
        var folders = named.Append(cwd).Concat(listedDirs).OfType<string>()
            .Distinct(ChangePaths.Comparer).Where(Directory.Exists).Take(MaxFolders).ToList();
        // Files already on the list have their copies; the folders only holding them aren't copied again.
        var listedFolders = listedDirs.ToHashSet(ChangePaths.Comparer);
        listedFolders.ExceptWith(named.Append(cwd).OfType<string>());

        // A folder the command names that isn't there yet will be made by it: everything in it afterwards is new.
        watch._newRoots.AddRange(named.Select(ChangePaths.NewRoot).OfType<string>().Distinct(ChangePaths.Comparer));
        // A command that names no folder (python gen.py) can still make one in Claude's folder, even a broad one.
        if (claudes is not null)
        {
            watch.NoteHome(claudes);
        }
        foreach (var folder in folders)
        {
            watch.Watch(folder, deep.Contains(folder), copy && !listedFolders.Contains(folder), budget);
        }
        // The subfolders of the deep ones: without a copy, a file a command changes there can only be compared with
        // git, and outside a repository not at all.
        if (copy)
        {
            foreach (var folder in folders.Where(deep.Contains))
            {
                if (ChangePaths.FilesUnder(folder, top: false).Any(info => !watch.TryCopy(info, budget)))
                {
                    break; // the budget is spent
                }
            }
        }
        return watch;
    }

    private void NoteHome(string claudes)
    {
        try
        {
            foreach (var dir in new DirectoryInfo(claudes).EnumerateDirectories().Take(ChangePaths.MaxWalk))
            {
                _homeDirs.Add(dir.FullName);
            }
            _home = claudes;
        }
        catch (Exception ex) when (Storage.IsFileError(ex) || ex is ArgumentException)
        {
        }
    }

    /// <summary>Notes what's in a folder now (copying its files when <paramref name="copy"/>) and watches it.</summary>
    private void Watch(string folder, bool subfolders, bool copy, CopyBudget budget)
    {
        _folders.Add(folder);
        try
        {
            foreach (var info in new DirectoryInfo(folder).EnumerateFiles().Take(ChangePaths.MaxWalk))
            {
                _before[info.FullName] = (info.Length, info.LastWriteTimeUtc);
                if (copy)
                {
                    TryCopy(info, budget);
                }
            }
            var watcher = new FileSystemWatcher(folder)
            {
                IncludeSubdirectories = subfolders,
                NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
                InternalBufferSize = WatcherBuffer,
            };
            watcher.Created += (_, a) => _touched.TryAdd(a.FullPath, true);
            watcher.Changed += (_, a) => _touched.TryAdd(a.FullPath, false);
            // sed -i and many editors write a temporary file and rename it over the original: a rename onto a path is
            // a change to it, not a new file (git tells the two apart later, see ChangeStore.List and Get).
            watcher.Renamed += (_, a) => _touched.TryAdd(a.FullPath, false);
            watcher.EnableRaisingEvents = true;
            _watchers.Add(watcher);
        }
        catch (Exception ex) when (Storage.IsFileError(ex) || ex is ArgumentException)
        {
            // A folder that can't be watched still gets its start-and-end comparison.
        }
    }

    /// <summary>Copies a small text file; false once the budget (count, bytes, time) is spent.</summary>
    private bool TryCopy(FileInfo info, CopyBudget budget)
    {
        if (Copies.Count >= MaxCopies || budget.TimeIsUp)
        {
            return false;
        }
        if (info.Length <= budget.MaxFile && info.Length <= budget.Bytes && !budget.Listed(info.FullName) &&
            !Copies.ContainsKey(info.FullName) && !ChangePaths.Ignored().IsMatch(info.FullName))
        {
            var blob = Blob.Read(info.FullName, budget.MaxFile);
            if (blob.IsText)
            {
                Copies[info.FullName] = blob;
                budget.Bytes -= blob.Size;
                _before.TryAdd(info.FullName, (info.Length, info.LastWriteTimeUtc));
            }
        }
        return true;
    }

    /// <summary>
    /// After the command: the files it created (true) or changed (false). At the top of the watched folders this
    /// compares with the start (reliable, no watcher needed); below, it's what the watchers saw; and every file in a
    /// folder the command made is new.
    /// </summary>
    public Dictionary<string, bool> Changes()
    {
        if (_watchers.Any(w => w.IncludeSubdirectories))
        {
            Thread.Sleep(CatchUp); // let the watcher catch up with the command's last writes in subfolders
        }
        var found = new Dictionary<string, bool>(_touched, ChangePaths.Comparer);
        foreach (var folder in _folders)
        {
            try
            {
                foreach (var info in new DirectoryInfo(folder).EnumerateFiles().Take(ChangePaths.MaxWalk))
                {
                    if (!_before.TryGetValue(info.FullName, out var was))
                    {
                        found[info.FullName] = true;
                    }
                    else if (was.Size != info.Length || was.Write != info.LastWriteTimeUtc)
                    {
                        found.TryAdd(info.FullName, false);
                    }
                }
            }
            catch (Exception ex) when (Storage.IsFileError(ex))
            {
            }
        }
        // A copied file in a subfolder is compared with the start too: its change doesn't hang on the watcher's timing.
        foreach (var (path, was) in _before)
        {
            if (!found.ContainsKey(path) && new FileInfo(path) is { Exists: true } info &&
                (was.Size != info.Length || was.Write != info.LastWriteTimeUtc))
            {
                found[path] = false;
            }
        }
        foreach (var folder in MadeFolders().Distinct(ChangePaths.Comparer).Where(f => !ChangePaths.Ignored().IsMatch(f + ChangePaths.Separator)))
        {
            foreach (var info in ChangePaths.FilesUnder(folder))
            {
                found[info.FullName] = true;
            }
        }
        return found;
    }

    /// <summary>Folders the command made: named by it, or new in Claude's folder.</summary>
    private List<string> MadeFolders()
    {
        var made = _newRoots.Where(Directory.Exists).ToList();
        if (_home is not null)
        {
            try
            {
                made.AddRange(new DirectoryInfo(_home).EnumerateDirectories().Take(ChangePaths.MaxWalk)
                    .Select(d => d.FullName).Where(d => !_homeDirs.Contains(d)));
            }
            catch (Exception ex) when (Storage.IsFileError(ex))
            {
            }
        }
        return made;
    }

    public void Dispose()
    {
        foreach (var watcher in _watchers)
        {
            watcher.Dispose();
        }
        _watchers.Clear();
    }
}

/// <summary>What copies before a shell command may still take: bytes, the largest file, and time (the hook waits).</summary>
internal sealed class CopyBudget(long bytes, long maxFile, TimeSpan time, Func<string, bool> listed)
{
    private readonly Stopwatch _clock = Stopwatch.StartNew();

    public long Bytes { get; set; } = bytes;

    public long MaxFile { get; } = maxFile;

    public bool TimeIsUp => _clock.Elapsed > time;

    /// <summary>A file already on the list has its copies: it isn't copied again.</summary>
    public bool Listed(string path) => listed(path);
}
