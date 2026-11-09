using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The files open in the change preview's tabs (js/preview.js), watched for changes made outside Termilly (an editor,
/// git, a build): each change, deletion or return is told to the page, which reads the file again. One watcher per
/// folder; a burst of writes to a file is told once, after it settles.
/// </summary>
internal sealed class PreviewWatchHandler(PageChannel page) : IMessageHandler, IDisposable
{
    /// <summary>How long a file must stay still before its change is told (an editor's save is several writes).</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);
    private static readonly StringComparer Paths = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    private readonly Lock _lock = new();
    /// <summary>A watched file's full path: the path as the page sent it, which it's told by.</summary>
    private Dictionary<string, string> _files = new(Paths);
    private readonly Dictionary<string, FileSystemWatcher> _folders = new(Paths);
    private readonly Dictionary<string, Timer> _pending = new(Paths);

    public void Register(MessageRouter router) => router.On<FromPage.PreviewWatch>(m => Watch(m.Paths ?? []));

    /// <summary>Watches these files from now on, and no others.</summary>
    public void Watch(IReadOnlyList<string> paths)
    {
        var files = new Dictionary<string, string>(Paths);
        foreach (var path in paths)
        {
            try
            {
                files.TryAdd(Path.GetFullPath(path), path);
            }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
            {
                // not a path here: nothing to watch
            }
        }
        var folders = files.Keys.Select(Path.GetDirectoryName).OfType<string>().Where(Directory.Exists).ToHashSet(Paths);
        lock (_lock)
        {
            _files = files;
            foreach (var gone in _folders.Keys.Where(f => !folders.Contains(f)).ToList())
            {
                _folders[gone].Dispose();
                _folders.Remove(gone);
            }
            foreach (var folder in folders.Where(f => !_folders.ContainsKey(f)))
            {
                _folders[folder] = Watcher(folder);
            }
        }
    }

    private FileSystemWatcher Watcher(string folder)
    {
        var watcher = new FileSystemWatcher(folder)
        {
            NotifyFilter = NotifyFilters.FileName | NotifyFilters.LastWrite | NotifyFilters.Size,
            IncludeSubdirectories = false,
        };
        watcher.Changed += (_, e) => Touched(e.FullPath);
        watcher.Created += (_, e) => Touched(e.FullPath);
        watcher.Deleted += (_, e) => Touched(e.FullPath);
        watcher.Renamed += (_, e) =>
        {
            Touched(e.OldFullPath);
            Touched(e.FullPath);
        };
        try
        {
            watcher.EnableRaisingEvents = true;
        }
        catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
        {
            // a folder that can't be watched (some network shares): its files reload only when Claude changes them
        }
        return watcher;
    }

    /// <summary>A file in a watched folder changed: told once it settles, if it's one open in the preview.</summary>
    private void Touched(string path)
    {
        lock (_lock)
        {
            if (!_files.ContainsKey(path))
            {
                return;
            }
            if (_pending.TryGetValue(path, out var timer))
            {
                timer.Change(Settle, Timeout.InfiniteTimeSpan);
                return;
            }
            _pending[path] = new Timer(_ => Tell(path), null, Settle, Timeout.InfiniteTimeSpan);
        }
    }

    private void Tell(string path)
    {
        string? sent;
        lock (_lock)
        {
            if (_pending.Remove(path, out var timer))
            {
                timer.Dispose();
            }
            sent = _files.GetValueOrDefault(path);
        }
        if (sent is not null)
        {
            page.Post(new ToPage.PreviewFileChanged(sent, File.Exists(path)));
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var watcher in _folders.Values)
            {
                watcher.Dispose();
            }
            foreach (var timer in _pending.Values)
            {
                timer.Dispose();
            }
            _folders.Clear();
            _pending.Clear();
        }
    }
}
