namespace Termilly.Desktop;

/// <summary>One run of a line diff: <see cref="Kind"/> is <see cref="Same"/>, <see cref="Removed"/> or <see cref="Added"/> (js/preview.js reads the numbers).</summary>
internal readonly record struct DiffRun(int Kind, int Count)
{
    public const int Same = 0;
    public const int Removed = 1;
    public const int Added = 2;
}

/// <summary>
/// A line diff for the change preview (Myers' O(ND) algorithm). The common start and end are trimmed first, and a
/// diff with more than <see cref="MaxDifferences"/> changed lines gives up and reports the middle as replaced, so
/// two unrelated big files cost little. Line endings are ignored when comparing; <see cref="Result.EolOnly"/> tells
/// when they are the only difference.
/// </summary>
internal static class LineDiff
{
    public const int MaxDifferences = 2000;
    /// <summary>Room past the diagonals -max..max that the search reads (k - 1 and k + 1 at the edges).</summary>
    private const int DiagonalSlack = 3;

    public sealed record Result(IReadOnlyList<DiffRun> Runs, int Added, int Removed, bool EolOnly);

    /// <summary>
    /// A text's lines, split on '\n' with a trailing '\r' kept. A last empty line (the text ends with a newline) is
    /// not a line of its own; js/preview.js splits the same way.
    /// </summary>
    public static string[] Lines(string text)
    {
        var lines = text.Split('\n');
        return lines.Length > 0 && lines[^1].Length == 0 ? lines[..^1] : lines;
    }

    public static Result Diff(string before, string after) => Diff(Lines(before), Lines(after));

    public static Result Diff(IReadOnlyList<string> before, IReadOnlyList<string> after)
    {
        // Lines become numbers, so comparing is cheap; '\r' is left out so CRLF and LF lines match.
        var ids = new Dictionary<string, int>(StringComparer.Ordinal);
        int Id(string line) => ids.TryGetValue(line.TrimEnd('\r'), out var id) ? id : ids[line.TrimEnd('\r')] = ids.Count;
        var a = before.Select(Id).ToArray();
        var b = after.Select(Id).ToArray();

        var start = 0;
        while (start < a.Length && start < b.Length && a[start] == b[start])
        {
            start++;
        }
        var end = 0;
        while (end < a.Length - start && end < b.Length - start && a[^(end + 1)] == b[^(end + 1)])
        {
            end++;
        }

        var runs = new List<DiffRun>();
        Add(runs, DiffRun.Same, start);
        var middle = Myers(a[start..^end], b[start..^end]) ?? [new DiffRun(DiffRun.Removed, a.Length - start - end), new DiffRun(DiffRun.Added, b.Length - start - end)];
        foreach (var run in middle)
        {
            Add(runs, run.Kind, run.Count);
        }
        Add(runs, DiffRun.Same, end);

        var grouped = Group(runs);
        var added = grouped.Where(r => r.Kind == DiffRun.Added).Sum(r => r.Count);
        var removed = grouped.Where(r => r.Kind == DiffRun.Removed).Sum(r => r.Count);
        var eolOnly = added == 0 && removed == 0 && !before.SequenceEqual(after, StringComparer.Ordinal);
        return new Result(grouped, added, removed, eolOnly);
    }

    private static void Add(List<DiffRun> runs, int kind, int count)
    {
        if (count == 0)
        {
            return;
        }
        if (runs.Count > 0 && runs[^1].Kind == kind)
        {
            runs[^1] = new DiffRun(kind, runs[^1].Count + count);
        }
        else
        {
            runs.Add(new DiffRun(kind, count));
        }
    }

    /// <summary>Within each changed block, removed lines come first and added lines after, as unified diffs show them.</summary>
    private static List<DiffRun> Group(List<DiffRun> runs)
    {
        var grouped = new List<DiffRun>();
        int removed = 0, added = 0;
        void Flush()
        {
            Add(grouped, DiffRun.Removed, removed);
            Add(grouped, DiffRun.Added, added);
            removed = added = 0;
        }
        foreach (var run in runs)
        {
            switch (run.Kind)
            {
                case DiffRun.Removed: removed += run.Count; break;
                case DiffRun.Added: added += run.Count; break;
                default: Flush(); Add(grouped, DiffRun.Same, run.Count); break;
            }
        }
        Flush();
        return grouped;
    }

    /// <summary>The shortest edit script from a to b, or null past <see cref="MaxDifferences"/>.</summary>
    private static List<DiffRun>? Myers(int[] a, int[] b)
    {
        if (a.Length == 0 || b.Length == 0)
        {
            return [new DiffRun(DiffRun.Removed, a.Length), new DiffRun(DiffRun.Added, b.Length)];
        }
        if (Search(a, b) is not { } trace)
        {
            return null;
        }
        var steps = WalkBack(trace, a.Length, b.Length);
        var runs = new List<DiffRun>();
        for (var i = steps.Count - 1; i >= 0; i--)
        {
            Add(runs, steps[i], 1);
        }
        return runs;
    }

    /// <summary>
    /// The forward search: for each number of differences d, the furthest x reached on each diagonal k before that
    /// round, up to the d that reaches the end (the trace's last entry); null when no d up to the limit does.
    /// </summary>
    private static List<int[]>? Search(int[] a, int[] b)
    {
        int n = a.Length, m = b.Length;
        var max = Math.Min(n + m, MaxDifferences);
        var offset = max + 1;
        var v = new int[2 * max + DiagonalSlack];
        var trace = new List<int[]>();
        for (var d = 0; d <= max; d++)
        {
            var snapshot = new int[2 * d + 1];
            Array.Copy(v, offset - d, snapshot, 0, snapshot.Length);
            trace.Add(snapshot);
            for (var k = -d; k <= d; k += 2)
            {
                var x = k == -d || (k != d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1;
                var y = x - k;
                while (x < n && y < m && a[x] == b[y])
                {
                    x++;
                    y++;
                }
                v[offset + k] = x;
                if (x >= n && y >= m)
                {
                    return trace;
                }
            }
        }
        return null;
    }

    /// <summary>Walks back from the end, one difference at a time: the steps (run kinds, one line each) in reverse.</summary>
    private static List<int> WalkBack(List<int[]> trace, int n, int m)
    {
        var steps = new List<int>(n + m);
        int px = n, py = m;
        for (var d = trace.Count - 1; d > 0; d--)
        {
            var previous = trace[d];
            int At(int k) => previous[k + d];
            var k0 = px - py;
            var prevK = k0 == -d || (k0 != d && At(k0 - 1) < At(k0 + 1)) ? k0 + 1 : k0 - 1;
            var prevX = At(prevK);
            var prevY = prevX - prevK;
            while (px > prevX && py > prevY)
            {
                steps.Add(DiffRun.Same);
                px--;
                py--;
            }
            steps.Add(px == prevX ? DiffRun.Added : DiffRun.Removed);
            px = prevX;
            py = prevY;
        }
        for (; px > 0 && py > 0; px--, py--)
        {
            steps.Add(DiffRun.Same);
        }
        return steps;
    }
}
