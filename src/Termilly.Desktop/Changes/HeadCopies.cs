using System.IO;
using System.Text;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>Git's copy of a file (missing when git doesn't have it), or null with a note saying why there's none.</summary>
internal sealed record HeadCopy(Blob? Before, string? Note);

/// <summary>A file as of git's last commit: what a change is compared with when there's no copy from before it.</summary>
internal sealed class HeadCopies(LocalGit git)
{
    /// <summary>The most a repository's root path or a file's size is read as.</summary>
    private const int MaxRootBytes = 4096;
    private const int MaxSizeBytes = 64;

    /// <summary>Git's copy: missing when git doesn't have it (new, untracked); null with a note when there's no repository or git can't show it.</summary>
    public HeadCopy Read(string path, long maxBytes)
    {
        var folder = Path.GetDirectoryName(path);
        while (folder is not null && !Directory.Exists(folder))
        {
            folder = Path.GetDirectoryName(folder); // the file and its folder may be gone
        }
        if (folder is null || git.Raw(folder, MaxRootBytes, GitCommands.RevParse, GitCommands.Options.ShowTopLevel) is not { } top)
        {
            return new(null, "Not in a git repository: showing the file as it is.");
        }
        var root = Encoding.UTF8.GetString(top).Trim();
        var relative = ChangePaths.RelativeForGit(root, path);
        if (git.Raw(root, MaxSizeBytes, GitCommands.CatFile, GitCommands.Options.SizeOnly, GitCommands.Object(GitCommands.Head, relative)) is not { } sizeText)
        {
            return new(Blob.Missing, null); // not in the last commit: a new file
        }
        if (long.TryParse(Encoding.ASCII.GetString(sizeText).Trim(), out var size) && size > maxBytes)
        {
            return new(new Blob(true, null, false, true, size), null);
        }
        return git.Raw(root, (int)Math.Min(maxBytes, int.MaxValue), GitCommands.Show, GitCommands.Object(GitCommands.Head, relative)) is { } bytes
            ? new(Blob.From(bytes, maxBytes), null)
            : new(null, "git couldn't show the last commit's copy.");
    }
}

/// <summary>Claude's edits replayed ("full edit" mode): the file after an edit, from the text before it.</summary>
internal static class EditReplay
{
    private const string Write = ClaudeTools.Write;
    private static readonly string[] Edits = [ClaudeTools.Edit, ClaudeTools.MultiEdit];

    /// <summary>The file after the edit; null when the edit doesn't apply (a text isn't in the file, a notebook's JSON).</summary>
    public static string? Rebuild(EditContent edit, string? before)
    {
        if (edit.Tool == Write)
        {
            return edit.Content;
        }
        if (!Edits.Contains(edit.Tool) || before is null || edit.Edits.Count == 0)
        {
            return null; // a notebook's JSON isn't rebuilt: its copy from disk is shown
        }
        var text = before;
        foreach (var change in edit.Edits)
        {
            if (change.Old is null || change.New is null)
            {
                return null;
            }
            if (change.Old.Length == 0)
            {
                // An empty old text means "create": Claude writes the new text as the whole file.
                text = change.New;
                continue;
            }
            var at = text.IndexOf(change.Old, StringComparison.Ordinal);
            if (at < 0)
            {
                return null;
            }
            text = change.ReplaceAll
                ? text.Replace(change.Old, change.New, StringComparison.Ordinal)
                : string.Concat(text.AsSpan(0, at), change.New, text.AsSpan(at + change.Old.Length));
        }
        return text;
    }
}

/// <summary>What the preview shows for a file, from the copies before and after a change.</summary>
internal static class ChangeViews
{
    private const long Megabyte = 1 << 20;
    private const long Kilobyte = 1024;

    public static ChangeView Build(string path, string display, Blob before, Blob after, int edits, string source, string? note)
    {
        if (!after.Exists && !before.Exists)
        {
            return new ChangeView(path, display, ChangeKinds.Missing, null, null, [], 0, 0, false, 0, 0, edits, source, note, "File not found.");
        }
        var beforeText = before.Text();
        var afterText = after.Text();
        var diff = beforeText is not null || afterText is not null ? LineDiff.Diff(beforeText ?? "", afterText ?? "") : null;
        if (before.TooLarge || after.TooLarge)
        {
            note = $"Too large to preview ({Size(Math.Max(before.Size, after.Size))}).";
        }
        return new ChangeView(path, display, ChangeKinds.Of(before, after, live: false),
            before.Exists ? beforeText : null, after.Exists ? afterText : null,
            diff?.Runs.Select(r => new[] { r.Kind, r.Count }).ToList() ?? [],
            diff?.Added ?? 0, diff?.Removed ?? 0, diff?.EolOnly ?? false,
            before.Size, after.Size, edits, source, note, null);
    }

    private static string Size(long bytes) =>
        bytes >= Megabyte ? $"{bytes / (double)Megabyte:0.#} MB" : $"{Math.Max(1, bytes / Kilobyte)} KB";
}
