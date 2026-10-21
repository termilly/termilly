namespace Termilly.Desktop;

/// <summary>A changed file the Git window's search found (js/gitsearch.js): by its path (line 0), or a line in it.</summary>
internal sealed record ChangeHit(string Path, string Display, bool Outside, int Line, string? Text);

/// <summary>
/// Searches the files Claude changed in a terminal, as they are on disk now: their paths and their lines. The Git
/// window's search runs this next to git's, so a terminal's changes are found outside a repository too, and after
/// they were committed.
/// </summary>
internal static class ChangeSearch
{
    /// <summary>Hits at most in all, and lines at most in one file (the rest of a file is a click away).</summary>
    public const int MaxHits = 200;
    public const int LinesPerFile = 5;
    /// <summary>The longest line a hit carries; the row shows a snippet around the match anyway.</summary>
    public const int MaxLineChars = 300;

    /// <summary>
    /// The files whose path or text has <paramref name="query"/> (any case), in the list's order: a path hit first,
    /// then the file's lines. A file that's gone, binary or over the size limit is found by its path only.
    /// </summary>
    public static IReadOnlyList<ChangeHit> Search(IEnumerable<ChangeItem> files, string query, long maxBytes, Func<string, long, Blob>? read = null)
    {
        read ??= (path, max) => Blob.Read(path, max);
        var hits = new List<ChangeHit>();
        if (string.IsNullOrWhiteSpace(query))
        {
            return hits;
        }
        foreach (var file in files)
        {
            if (file.Display.Contains(query, StringComparison.OrdinalIgnoreCase))
            {
                hits.Add(new ChangeHit(file.Path, file.Display, file.Outside, 0, null));
            }
            hits.AddRange(Lines(file, query, read(file.Path, maxBytes)));
            if (hits.Count >= MaxHits)
            {
                break;
            }
        }
        return hits.Take(MaxHits).ToList();
    }

    private static IEnumerable<ChangeHit> Lines(ChangeItem file, string query, Blob blob)
    {
        if (blob.Text() is not { } text)
        {
            yield break;
        }
        var found = 0;
        var number = 0;
        foreach (var line in text.Split('\n'))
        {
            number++;
            if (!line.Contains(query, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            var shown = line.TrimEnd('\r');
            yield return new ChangeHit(file.Path, file.Display, file.Outside, number, shown.Length > MaxLineChars ? shown[..MaxLineChars] : shown);
            if (++found >= LinesPerFile)
            {
                yield break;
            }
        }
    }
}
