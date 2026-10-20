namespace Termilly.Desktop;

/// <summary>What a change does to a file, as the preview and the list call it.</summary>
internal static class ChangeKinds
{
    public const string Modified = "modified";
    public const string Created = "created";
    public const string Deleted = "deleted";
    public const string Binary = "binary";
    public const string Large = "large";
    public const string Missing = "missing";

    /// <summary>What a change does, from the copies before and after it.</summary>
    /// <param name="live">There are no copies (git mode, or they were let go): it can only be "modified".</param>
    public static string Of(Blob? before, Blob? after, bool live)
    {
        if (live || after is null)
        {
            return Modified;
        }
        if (after.Binary || before?.Binary == true)
        {
            return Binary;
        }
        if (after.TooLarge || before?.TooLarge == true)
        {
            return Large;
        }
        if (before is { Exists: false } && after.Exists)
        {
            return Created;
        }
        return before is { Exists: true } && !after.Exists ? Deleted : Modified;
    }
}

/// <summary>Where the copy a change is shown from came from.</summary>
internal static class ChangeSources
{
    /// <summary>Read from the disk.</summary>
    public const string Snapshot = "snapshot";

    /// <summary>Rebuilt from Claude's edit.</summary>
    public const string Edit = "edit";

    /// <summary>The last commit (no copy from before, or git mode).</summary>
    public const string Git = "git";
}

/// <summary>A file Claude changed in a terminal, and the copies kept of it.</summary>
internal sealed class FileChange(string path, string tool)
{
    public string Path { get; } = path;
    public string Tool { get; set; } = tool;
    public DateTime At { get; set; } = DateTime.UtcNow;
    public int Edits { get; set; }
    /// <summary>Before Claude's first edit of it in this list.</summary>
    public Blob? First { get; set; }
    /// <summary>Before Claude's last edit.</summary>
    public Blob? LastBefore { get; set; }
    /// <summary>After Claude's last edit.</summary>
    public Blob? After { get; set; }
    /// <summary>No copy from before the first edit (the hook was late): the preview compares with git instead.</summary>
    public bool BeforeUnknown { get; set; }
    /// <summary>Copies dropped to save memory, or never taken (git mode): the preview reads git and the disk.</summary>
    public bool Live { get; set; }
    /// <summary>Where the last copy came from: one of <see cref="ChangeSources"/>.</summary>
    public string Source { get; set; } = ChangeSources.Snapshot;
    public string? Note { get; set; }
    public LineDiff.Result? Counts { get; set; }
    /// <summary>Git's copy, read once for the list when there is no copy from before (see ChangeStore.List).</summary>
    public Blob? Baseline { get; set; }

    public long Bytes =>
        new[] { First, LastBefore, After }.Where(b => b?.Bytes is not null).Distinct().Sum(b => (long)b!.Bytes!.Length);

    public void Forget()
    {
        First = LastBefore = After = null;
        Counts = null;
        Live = true;
    }
}

/// <summary>What the preview shows for one file: both texts, the diff between them, and why it may be partial.</summary>
internal sealed record ChangeView(
    string Path, string Display, string Kind, string? Before, string? After, IReadOnlyList<int[]> Ops, int Added,
    int Removed, bool EolOnly, long BeforeSize, long AfterSize, int Edits, string Source, string? Note, string? Error);

/// <summary>A file in a pane's list of changed files.</summary>
internal sealed record ChangeItem(
    string Path, string Display, bool Outside, string Tool, DateTime At, int Edits, string Kind, int Added, int Removed);

/// <summary>The files Claude changed in one terminal, copies taken before tools ran, and the shell command being watched.</summary>
internal sealed class ChangePane
{
    public const int MaxFiles = 1000;

    public string? Session { get; set; }
    public string? Cwd { get; set; }
    public OrderedDictionary<string, FileChange> Files { get; } = new(ChangePaths.Comparer);
    public Dictionary<string, (Blob Blob, DateTime At)> Pending { get; } = new(ChangePaths.Comparer);
    /// <summary>The folders being watched while a shell command runs (see ShellWatch).</summary>
    public ShellWatch? Watch { get; set; }

    /// <summary>The file on the list (added, now), for a change by <paramref name="tool"/>.</summary>
    public FileChange FileOf(string path, string? tool)
    {
        if (!Files.TryGetValue(path, out var file))
        {
            Files[path] = file = new FileChange(path, tool ?? ClaudeTools.Edit);
        }
        file.Tool = tool ?? file.Tool;
        file.At = DateTime.UtcNow;
        return file;
    }

    /// <summary>Keeps at most <see cref="MaxFiles"/> files, dropping the oldest.</summary>
    public void Trim()
    {
        while (Files.Count > MaxFiles)
        {
            Files.Remove(Files.Values.MinBy(f => f.At)!.Path);
        }
    }

    /// <summary>Stops watching a shell command.</summary>
    public void StopWatching()
    {
        Watch?.Dispose();
        Watch = null;
    }
}
