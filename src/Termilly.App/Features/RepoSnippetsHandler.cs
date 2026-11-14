using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// A repository's snippets and tasks for the page (RepoSnippets.cs, js/reposnippets.js): read when asked, written when
/// saved, and watched once read, so a git pull or an editor's change shows at once. The watchers stay on the last few
/// repositories asked about.
/// </summary>
internal sealed class RepoSnippetsHandler(PageChannel page) : IMessageHandler, IDisposable
{
    /// <summary>How many repositories are watched at once; the one asked about longest ago stops first.</summary>
    private const int MaxWatched = 8;
    /// <summary>How long the files must stay still before the change is told (a save is several writes, a pull many).</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(300);

    private readonly Lock _lock = new();
    /// <summary>The watched repositories, the last asked about at the end, each with its folder's watchers.</summary>
    private readonly List<(string Root, List<FileSystemWatcher> Watchers)> _watched = [];
    private readonly Dictionary<string, Timer> _pending = new(ChangePaths.Comparer);

    public void Register(MessageRouter router)
    {
        router.On<FromPage.RepoSnippetsAsk>(m => Task.Run(() =>
        {
            var found = RepoSnippets.Read(m.RequestId, m.Folder ?? "");
            page.Post(found);
            if (found.Root is { } root)
            {
                Watch(root);
            }
        }));
        router.On<FromPage.RepoSnippetsSave>(m => Task.Run(() =>
        {
            string? error = null;
            try
            {
                RepoSnippets.Write(m.Root ?? "", m.Snippets ?? [], m.OnlyMe);
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException)
            {
                error = e.Message;
            }
            page.Post(new ToPage.RepoSnippetsSaved(m.RequestId, error));
        }));
    }

    private void Watch(string root)
    {
        lock (_lock)
        {
            var at = _watched.FindIndex(w => ChangePaths.Comparer.Equals(w.Root, root));
            if (at >= 0)
            {
                var entry = _watched[at];
                _watched.RemoveAt(at);
                _watched.Add(entry);
                return;
            }
            _watched.Add((root, Watchers(root)));
            while (_watched.Count > MaxWatched)
            {
                _watched[0].Watchers.ForEach(w => w.Dispose());
                _watched.RemoveAt(0);
            }
        }
    }

    /// <summary>
    /// The repository's folder (its .termilly.yml, and .termilly or .vscode made or removed) and those two folders.
    /// Not the whole tree: a build writes thousands of files a second.
    /// </summary>
    private List<FileSystemWatcher> Watchers(string root)
    {
        var list = new List<FileSystemWatcher>();
        foreach (var folder in new[] { root, Path.Combine(root, RepoSnippets.Folder), Path.Combine(root, VsCodeTasks.Folder) })
        {
            if (!Directory.Exists(folder))
            {
                continue;
            }
            var watcher = new FileSystemWatcher(folder) { NotifyFilter = NotifyFilters.FileName | NotifyFilters.DirectoryName | NotifyFilters.LastWrite | NotifyFilters.Size };
            FileSystemEventHandler touched = (_, e) => Touched(root, e.FullPath);
            watcher.Changed += touched;
            watcher.Created += touched;
            watcher.Deleted += touched;
            watcher.Renamed += (_, e) => Touched(root, e.FullPath);
            try
            {
                watcher.EnableRaisingEvents = true;
            }
            catch (Exception e) when (e is IOException or ArgumentException or UnauthorizedAccessException)
            {
                // a folder that can't be watched (some network shares): it's read again when the list opens
            }
            list.Add(watcher);
        }
        return list;
    }

    /// <summary>Something in a watched folder changed: told once it settles, when it's one of the files read.</summary>
    private void Touched(string root, string path)
    {
        var name = Path.GetFileName(path);
        var relevant = name is RepoSnippets.Folder or VsCodeTasks.Folder or RepoSnippets.FileName or VsCodeTasks.FileName
            || name == WorkspaceLayout.FileName;
        if (!relevant)
        {
            return;
        }
        lock (_lock)
        {
            if (_pending.TryGetValue(root, out var timer))
            {
                timer.Change(Settle, Timeout.InfiniteTimeSpan);
                return;
            }
            _pending[root] = new Timer(_ => Tell(root), null, Settle, Timeout.InfiniteTimeSpan);
        }
    }

    private void Tell(string root)
    {
        lock (_lock)
        {
            if (_pending.Remove(root, out var timer))
            {
                timer.Dispose();
            }
            // A folder made or removed since: watched (or not) from now on.
            var at = _watched.FindIndex(w => ChangePaths.Comparer.Equals(w.Root, root));
            if (at >= 0)
            {
                _watched[at].Watchers.ForEach(w => w.Dispose());
                _watched[at] = (root, Watchers(root));
            }
        }
        page.Post(new ToPage.RepoSnippetsChanged(root));
    }

    public void Dispose()
    {
        lock (_lock)
        {
            foreach (var (_, watchers) in _watched)
            {
                watchers.ForEach(w => w.Dispose());
            }
            foreach (var timer in _pending.Values)
            {
                timer.Dispose();
            }
            _watched.Clear();
            _pending.Clear();
        }
    }
}
