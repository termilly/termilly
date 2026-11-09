using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// The change preview's memory: for every terminal, the files Claude changed there and copies of them from before
/// and after its edits. The copies are taken while the hook waits for Termilly's answer, so the one from before an
/// edit is always taken before Claude's tool runs. Everything stays on this PC, in memory, within limits.
/// </summary>
internal sealed class ChangeStore
{
    public const int MaxFilesPerPane = ChangePane.MaxFiles;
    /// <summary>The longest list of files one shell command is taken to have changed (a build writes thousands).</summary>
    public const int MaxShellFiles = 200;
    public const long DefaultMaxTotalBytes = 96L << 20;
    private const long BytesPerKb = 1024;
    private const string DefaultTool = ClaudeTools.Edit;
    private static readonly string[] SessionEnds = [HookEvents.Stop, HookEvents.StopFailure, HookEvents.SessionEnd];
    /// <summary>A copy taken before a tool that never reported back (denied, failed) is let go after this long.</summary>
    private static readonly TimeSpan PendingLife = TimeSpan.FromMinutes(10);
    /// <summary>How long copies before a shell command may take: the hook gives up on Termilly after a second.</summary>
    private static readonly TimeSpan ShellCopyTime = TimeSpan.FromMilliseconds(300);

    private readonly Dictionary<string, ChangePane> _panes = new(StringComparer.Ordinal);
    private readonly Lock _lock = new();
    private readonly long _maxTotalBytes;
    private readonly TimeSpan _copyTime;

    /// <param name="maxTotalBytes">The most all copies may take, across terminals.</param>
    /// <param name="copyTime">How long a shell command's copies may take before it runs (tests give it longer).</param>
    public ChangeStore(long maxTotalBytes = DefaultMaxTotalBytes, TimeSpan? copyTime = null) =>
        (_maxTotalBytes, _copyTime) = (maxTotalBytes, copyTime ?? ShellCopyTime);

    /// <summary>Raised (on the hook's thread) when a pane's list of changed files changes.</summary>
    public event Action<string>? Changed;

    /// <summary>
    /// Records what an agent event means for the pane's files. Called before the hook gets its answer, so the copy
    /// from before an edit is taken before the edit happens. Returns <see cref="HookReply.SendEdit"/> when the edit
    /// itself is wanted ("full edit" mode).
    /// </summary>
    public HookReply OnEvent(AgentEvent e, AppSettings settings)
    {
        var path = e.File is null ? null : ChangePaths.Normalize(e.File, e.Cwd);
        var shell = e.File is null && ClaudeTools.ShellTools.Contains(e.Tool) && settings.Changes.ShellFiles;
        switch (e.Event)
        {
            case HookEvents.SessionStart when NewSession(e, settings):
                Changed?.Invoke(e.Pane);
                break;
            case var end when SessionEnds.Contains(end):
                Ended(e.Pane);
                break;
            case HookEvents.PreToolUse when path is not null:
                Before(e, path, settings);
                break;
            case HookEvents.PostToolUse when path is not null:
                After(e, path, settings);
                Changed?.Invoke(e.Pane);
                return settings.Changes.Source == SettingValues.ChangeSource.FullEdits ? HookReply.SendEdit : HookReply.Ok;
            case HookEvents.PreToolUse when shell:
                StartWatch(e, settings);
                break;
            case HookEvents.PostToolUse when shell && FinishWatch(e, settings):
                Changed?.Invoke(e.Pane);
                break;
        }
        return HookReply.Ok;
    }

    /// <summary>Claude stopped: copies for tools that never reported back go (a denied or failed tool), and so does a watch.</summary>
    private void Ended(string paneId)
    {
        lock (_lock)
        {
            if (_panes.TryGetValue(paneId, out var pane))
            {
                pane.Pending.Clear();
                pane.StopWatching();
            }
        }
    }

    /// <summary>Before an edit: a copy of the file as it is (not in git mode, which keeps no copies).</summary>
    private void Before(AgentEvent e, string path, AppSettings settings)
    {
        if (settings.Changes.Source == SettingValues.ChangeSource.Git)
        {
            return;
        }
        var before = Blob.Read(path, MaxBytes(settings));
        lock (_lock)
        {
            var pane = PaneOf(e);
            foreach (var old in pane.Pending.Where(p => DateTime.UtcNow - p.Value.At > PendingLife).Select(p => p.Key).ToList())
            {
                pane.Pending.Remove(old);
            }
            pane.Pending[path] = (before, DateTime.UtcNow);
        }
    }

    /// <summary>After an edit: the file now, recorded against the copy from before it (or its last copy).</summary>
    private void After(AgentEvent e, string path, AppSettings settings)
    {
        NewSession(e, settings);
        var after = settings.Changes.Source == SettingValues.ChangeSource.Git ? null : Blob.Read(path, MaxBytes(settings));
        lock (_lock)
        {
            var pane = PaneOf(e);
            var before = pane.Pending.Remove(path, out var pending) ? pending.Blob : pane.Files.GetValueOrDefault(path)?.After;
            Record(pane, path, e.Tool, before, after, settings);
        }
    }

    /// <summary>
    /// Records one change to a file (under the lock): <paramref name="before"/> is the copy from before it (null when
    /// there is none: the preview compares with git), <paramref name="after"/> the file now (null in git mode, which
    /// keeps no copies).
    /// </summary>
    private void Record(ChangePane pane, string path, string? tool, Blob? before, Blob? after, AppSettings settings)
    {
        var file = pane.FileOf(path, tool);
        if (settings.Changes.Source == SettingValues.ChangeSource.Git || after is null)
        {
            file.Live = true;
            file.Edits++;
            return;
        }
        if (file.Edits == 0 || file.Live)
        {
            file.First = before;
            file.BeforeUnknown = before is null;
            file.Live = false;
        }
        file.LastBefore = before;
        file.After = after;
        file.Edits++;
        file.Source = ChangeSources.Snapshot;
        file.Note = null;
        file.Counts = null;
        pane.Trim();
        Evict();
    }

    // ---- Files changed by shell commands ----

    /// <summary>Before a shell command: the folders it may change are watched, with copies from before it (see ShellWatch).</summary>
    private void StartWatch(AgentEvent e, AppSettings settings)
    {
        lock (_lock)
        {
            var pane = PaneOf(e);
            if (pane.Watch is { } running && DateTime.UtcNow - running.Started < PendingLife)
            {
                running.Running++; // commands in parallel share one watch
                return;
            }
            pane.StopWatching();
            var claudes = pane.Cwd is null ? null : ChangePaths.Normalize(pane.Cwd, null);
            var named = (e.Dirs ?? []).Select(d => ChangePaths.Normalize(d, claudes)).OfType<string>().ToList();
            var budget = new CopyBudget(ShellWatch.MaxCopyBytes, Math.Min(MaxBytes(settings), ShellWatch.MaxCopyBytes), _copyTime, pane.Files.ContainsKey);
            pane.Watch = ShellWatch.Begin(named, claudes, pane.Files.Keys, settings.Changes.Source != SettingValues.ChangeSource.Git, budget);
        }
    }

    /// <summary>
    /// After a shell command: the files it created or changed in the watched folders go on the list. A file already
    /// on it is compared with Termilly's copy from Claude's last change; a new file has nothing before it; any other
    /// changed file is compared with git. Returns whether anything was recorded.
    /// </summary>
    private bool FinishWatch(AgentEvent e, AppSettings settings)
    {
        ShellWatch? watch;
        lock (_lock)
        {
            if (!_panes.TryGetValue(e.Pane, out var pane) || pane.Watch is null)
            {
                return false;
            }
            watch = pane.Watch;
            if (--watch.Running <= 0)
            {
                pane.Watch = null;
            }
        }
        var found = watch.Changes();
        if (watch.Running <= 0)
        {
            watch.Dispose();
        }
        var max = MaxBytes(settings);
        var recorded = false;
        foreach (var (path, created) in found.Where(f => !ChangePaths.Ignored().IsMatch(f.Key) && File.Exists(f.Key)).Take(MaxShellFiles))
        {
            var after = settings.Changes.Source == SettingValues.ChangeSource.Git ? null : Blob.Read(path, max);
            lock (_lock)
            {
                var pane = PaneOf(e);
                var known = pane.Files.GetValueOrDefault(path);
                Blob? before = known is { Live: false } ? known.After
                    : watch.Copies.TryGetValue(path, out var copy) ? copy
                    : created && !watch.WasThere(path) ? Blob.Missing
                    : null;
                if (before is not null && after is not null && before.SameAs(after))
                {
                    continue; // touched but not changed
                }
                Record(pane, path, e.Tool, before, after, settings);
                recorded = true;
            }
        }
        return recorded;
    }

    /// <summary>
    /// The edit itself ("full edit" mode): the file after the edit is rebuilt from the text before it plus Claude's
    /// replacements. When that isn't possible (a text was too long, or isn't in the file), the copy read from disk
    /// stays, with a note.
    /// </summary>
    public void OnEdit(EditContent edit, AppSettings settings)
    {
        if (ChangePaths.Normalize(edit.File, edit.Cwd) is not { } path)
        {
            return;
        }
        var max = MaxBytes(settings);
        lock (_lock)
        {
            if (!_panes.TryGetValue(edit.Pane, out var pane) || !pane.Files.TryGetValue(path, out var file))
            {
                return;
            }
            if (edit.Original is not null && file.Edits == 1)
            {
                file.First = file.LastBefore = Blob.FromText(edit.Original, max);
                file.BeforeUnknown = false;
            }
            var rebuilt = edit.Truncated ? null : EditReplay.Rebuild(edit, edit.Original ?? file.LastBefore?.Text());
            if (rebuilt is null)
            {
                file.Note = "Showing the file as it is on disk: Claude's edit couldn't be replayed.";
            }
            else
            {
                file.After = Blob.FromText(rebuilt, max);
                file.Source = ChangeSources.Edit;
                file.Note = null;
            }
            file.Counts = null;
            Evict();
        }
        Changed?.Invoke(edit.Pane);
    }

    /// <summary>Forgets a terminal's changes: it closed, or restarted.</summary>
    public void Forget(string pane)
    {
        bool had;
        lock (_lock)
        {
            had = _panes.Remove(pane, out var gone) && gone.Files.Count > 0;
            gone?.StopWatching();
        }
        if (had)
        {
            Changed?.Invoke(pane);
        }
    }

    /// <summary>The user cleared the pane's list, or removed one file from it (path).</summary>
    public void Clear(string paneId, string? path)
    {
        lock (_lock)
        {
            if (!_panes.TryGetValue(paneId, out var pane))
            {
                return;
            }
            if (path is null)
            {
                pane.Files.Clear();
                pane.Pending.Clear();
            }
            else
            {
                pane.Files.Remove(ChangePaths.Normalize(path, null) ?? path);
            }
        }
        Changed?.Invoke(paneId);
    }

    /// <summary>Forgets everything (the change preview was turned off).</summary>
    public void Clear()
    {
        List<string> panes;
        lock (_lock)
        {
            panes = _panes.Where(p => p.Value.Files.Count > 0).Select(p => p.Key).ToList();
            foreach (var pane in _panes.Values)
            {
                pane.StopWatching();
            }
            _panes.Clear();
        }
        foreach (var pane in panes)
        {
            Changed?.Invoke(pane);
        }
    }

    /// <summary>Runs <paramref name="read"/> on a pane's list under the store's lock (null when the pane has none).</summary>
    internal T Read<T>(string paneId, Func<ChangePane?, T> read)
    {
        lock (_lock)
        {
            return read(_panes.GetValueOrDefault(paneId));
        }
    }

    /// <summary>Runs <paramref name="change"/> under the store's lock.</summary>
    internal void Locked(Action change)
    {
        lock (_lock)
        {
            change();
        }
    }

    internal static long MaxBytes(AppSettings settings) => settings.Changes.MaxFileKb * BytesPerKb;

    /// <summary>Starts a new list when a new Claude session starts in the pane, if set to.</summary>
    private bool NewSession(AgentEvent e, AppSettings settings)
    {
        lock (_lock)
        {
            var pane = PaneOf(e);
            var isNew = e.Session is not null && pane.Session is not null && e.Session != pane.Session;
            pane.Session = e.Session ?? pane.Session;
            if (isNew && settings.Changes.Keep == SettingValues.ChangeKeep.PerSession && pane.Files.Count > 0)
            {
                pane.Files.Clear();
                pane.Pending.Clear();
                return true;
            }
            return false;
        }
    }

    private ChangePane PaneOf(AgentEvent e)
    {
        if (!_panes.TryGetValue(e.Pane, out var pane))
        {
            _panes[e.Pane] = pane = new ChangePane();
        }
        pane.Cwd = e.Cwd ?? pane.Cwd;
        return pane;
    }

    /// <summary>Keeps the copies within the memory limit, dropping those of the files changed longest ago.</summary>
    private void Evict()
    {
        var total = _panes.Values.SelectMany(p => p.Files.Values).Sum(f => f.Bytes) +
                    _panes.Values.SelectMany(p => p.Pending.Values).Sum(p => (long)(p.Blob.Bytes?.Length ?? 0));
        foreach (var file in _panes.Values.SelectMany(p => p.Files.Values).Where(f => !f.Live).OrderBy(f => f.At).ToList())
        {
            if (total <= _maxTotalBytes)
            {
                break;
            }
            total -= file.Bytes;
            file.Forget();
            file.Note = "Termilly let go of its copies to save memory: comparing with the last commit.";
        }
    }
}
