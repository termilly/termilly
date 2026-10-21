using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>The file a printed path means and the line it named, or why there's none.</summary>
internal sealed record ResolvedPath(string? Path, int? Line, string? Error)
{
    public static ResolvedPath NotAPath { get; } = new(null, null, "That isn't a file path.");
}

/// <summary>
/// What the change preview shows from the store's copies (js/preview.js): a terminal's list of changed files with
/// their line counts, one file's change, and which file a path printed in a terminal means.
/// </summary>
internal sealed class ChangePreview(ChangeStore store, LocalGit git)
{
    /// <summary>The largest copy of git's version read for the list's counts.</summary>
    private const long MaxBaselineBytes = 2L << 20;

    private readonly HeadCopies _head = new(git);

    /// <summary>The pane's changed files, most recent first, with added and removed line counts.</summary>
    public IReadOnlyList<ChangeItem> List(string paneId)
    {
        var (files, cwd) = store.Read(paneId, pane => pane is null
            ? ([], null)
            : (pane.Files.Values.Select(f => (File: f, f.First, f.After, f.Counts)).ToList(), pane.Cwd));
        return files.Select(f => Item(f.File, f.First, f.After, f.Counts, cwd)).OrderByDescending(i => i.At).ToList();
    }

    /// <summary>The pane's changed files whose path or text has <paramref name="query"/>, for the Git window's search.</summary>
    public IReadOnlyList<ChangeHit> Search(string paneId, string query, AppSettings settings) =>
        ChangeSearch.Search(List(paneId), query, ChangeStore.MaxBytes(settings));

    private ChangeItem Item(FileChange file, Blob? first, Blob? after, LineDiff.Result? counts, string? cwd)
    {
        // With no copy from before (a shell command changed a file deep in a project), the last commit stands in: the
        // file is new if git doesn't have it, and the counts are against git's copy.
        var baseline = file.BeforeUnknown ? file.Baseline ??= _head.Read(file.Path, MaxBaselineBytes).Before : first;
        // A file that didn't exist before (or doesn't now) counts as empty, so a new file is all added lines.
        static string? Text(Blob? blob) => blob is { Exists: false } ? "" : blob?.Text();
        if (counts is null && Text(baseline) is { } a && Text(after) is { } b)
        {
            var diff = LineDiff.Diff(a, b);
            counts = diff;
            store.Locked(() =>
            {
                if (ReferenceEquals(file.After, after))
                {
                    file.Counts = diff;
                }
            });
        }
        var (display, outside) = ChangePaths.Display(file.Path, cwd);
        return new ChangeItem(file.Path, display, outside, file.Tool, file.At, file.Edits,
            ChangeKinds.Of(baseline, after, file.Live), counts?.Added ?? 0, counts?.Removed ?? 0);
    }

    /// <summary>
    /// What the preview shows for a file: Claude's change from the copies kept ("session": since its first edit,
    /// "last": its last edit only), or the file against git's HEAD when there are no copies (git mode, a file Claude
    /// didn't change here, copies dropped to save memory).
    /// </summary>
    public ChangeView Get(string paneId, string path, string compare, AppSettings settings)
    {
        path = ChangePaths.Normalize(path, null) ?? path;
        var max = ChangeStore.MaxBytes(settings);
        var (file, cwd, useCopies, before, after) = store.Read(paneId, pane =>
        {
            if (pane is null || !pane.Files.TryGetValue(path, out var found))
            {
                return (null, pane?.Cwd, false, null, null);
            }
            if (found.Live || settings.Changes.Source == SettingValues.ChangeSource.Git)
            {
                return (found, pane.Cwd, false, null, null);
            }
            var last = compare == SettingValues.ChangeCompare.LastEdit;
            return ((FileChange?)found, pane.Cwd, true, last ? found.LastBefore : found.BeforeUnknown ? null : found.First, found.After);
        });
        var (display, _) = ChangePaths.Display(path, cwd);
        if (useCopies)
        {
            return FromCopies(path, display, file!, before, after, max);
        }
        // No copies to show: the disk against git's last commit, or the file alone.
        var disk = Blob.Read(path, max);
        var (head, gitNote) = _head.Read(path, max);
        return ChangeViews.Build(path, display, head ?? disk, disk, file?.Edits ?? 0, ChangeSources.Git, head is null ? gitNote : file?.Note);
    }

    /// <summary>A change from the copies kept: the disk stands in for a copy after it, git (or the file itself) for one before.</summary>
    private ChangeView FromCopies(string path, string display, FileChange file, Blob? before, Blob? after, long max)
    {
        var note = file.Note;
        var disk = Blob.Read(path, max);
        if (after is not null && !disk.SameAs(after))
        {
            note ??= "The file has changed since Claude's last edit.";
        }
        after ??= disk;
        if (before is null)
        {
            (before, var gitNote) = _head.Read(path, max);
            // No git either: the file alone.
            note ??= before is null
                ? "No copy from before this change, and not in a git repository: showing the file as it is now."
                : gitNote ?? "No copy from before Claude's first edit: comparing with the last commit.";
            before ??= after;
        }
        return ChangeViews.Build(path, display, before, after, file.Edits, file.Source, note);
    }

    /// <summary>
    /// The file a path printed in a terminal means (Ctrl+click): a file Claude changed in that pane first (its output
    /// often shows paths relative to where it works), then an absolute path, then relative to the folders given. A
    /// path on another machine (SSH, WSL) can't be previewed.
    /// </summary>
    public ResolvedPath Resolve(string paneId, string text, bool remote, params string?[] folders)
    {
        var (clean, line) = ChangePaths.Clean(text);
        if (clean.Length == 0)
        {
            return ResolvedPath.NotAPath;
        }
        var asSystem = ChangePaths.AsSystem(clean);
        var (known, cwd, hasPane) = store.Read(paneId, pane =>
        {
            if (pane is null)
            {
                return (null, null, false);
            }
            var tail = ChangePaths.Separator + asSystem.TrimStart('.', ChangePaths.Separator);
            var match = pane.Files.Keys.FirstOrDefault(p => p.Equals(asSystem, ChangePaths.Comparison))
                        ?? pane.Files.Keys.FirstOrDefault(p => p.EndsWith(tail, ChangePaths.Comparison));
            return (match, pane.Cwd, true);
        });
        if (known is not null)
        {
            return new(known, line, null);
        }
        if (hasPane)
        {
            folders = [cwd, .. folders];
        }
        if (remote || ChangePaths.IsElsewhere(clean))
        {
            return new(null, null, ChangePaths.ElsewhereMessage);
        }
        clean = ChangePaths.ExpandHome(clean);
        foreach (var folder in folders.Where(f => !string.IsNullOrWhiteSpace(f)).Prepend(null))
        {
            if (ChangePaths.Normalize(clean, folder) is { } candidate && File.Exists(candidate))
            {
                return new(candidate, line, null);
            }
        }
        return new(null, null, $"File not found: {clean}");
    }
}
