using System.Buffers.Binary;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>A terminal's earlier output that a search found: the lines around each match, and how many matched.</summary>
internal sealed record EarlierHit(string Id, IReadOnlyList<string> Lines, int Count);

/// <summary>
/// A terminal's earlier output: the lines that left its scrollback, scrolled past the limit or wiped by a program
/// that clears it (Claude Code does, each time it draws itself again), kept so search still finds them
/// (js/earlier.js sends them). One encrypted file per terminal under history\earlier, its terminal's id for a name,
/// appended a sealed chunk at a time and never rewritten but to drop chunks past the history setting (Forever keeps
/// them). A closed terminal's file stays, named in its history entry; reopening it passes the file on.
/// </summary>
internal sealed partial class EarlierOutput(Vault vault)
{
    private const string Extension = ".tme";
    private const string FolderName = "earlier";
    private const int LengthSize = sizeof(int);
    /// <summary>The fields of a chunk: when it was kept, and its lines.</summary>
    private const string AtField = "at";
    private const string LinesField = "lines";
    /// <summary>A search gives at most this many of a terminal's matches with lines around them (the newest).</summary>
    public const int MaxShownHits = 300;
    /// <summary>Lines kept around each match: as many as the search's preview shows (js/palette.js).</summary>
    public const int Before = 9;
    public const int After = 12;
    /// <summary>Stands between two runs of lines that aren't next to each other.</summary>
    public const string Gap = "⋯";

    private readonly Lock _gate = new();
    /// <summary>Each file's lines once read (search reads them often), kept up to date as lines are added.</summary>
    private readonly Dictionary<string, List<string>> _read = [];

    private string Folder => Path.Combine(vault.HistoryDirectory, FolderName);
    private byte[] Key => vault.Key ?? throw new InvalidOperationException("History is locked.");
    private string PathOf(string id) => Path.Combine(Folder, id + Extension);

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex ValidId();

    /// <summary>Adds lines to a terminal's earlier output (secrets taken out first, when Settings asks).</summary>
    public void Append(string id, IReadOnlyList<string> lines, bool redactSecrets)
    {
        if (!ValidId().IsMatch(id) || lines.Count == 0)
        {
            return;
        }
        var kept = redactSecrets ? SecretRedactor.Redact(lines) : lines;
        var chunk = new JsonObject
        {
            [AtField] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            [LinesField] = new JsonArray(kept.Select(l => (JsonNode?)l).ToArray()),
        };
        var sealedChunk = Sealed.Seal(Key, chunk.ToJsonString());
        lock (_gate)
        {
            Directory.CreateDirectory(Folder);
            using (var file = new FileStream(PathOf(id), FileMode.Append, FileAccess.Write, FileShare.Read))
            {
                WriteChunk(file, sealedChunk);
            }
            if (_read.TryGetValue(id, out var known))
            {
                known.AddRange(kept);
            }
        }
    }

    /// <summary>One chunk: its length, then its sealed bytes.</summary>
    private static void WriteChunk(Stream stream, byte[] sealedChunk)
    {
        var length = new byte[LengthSize];
        BinaryPrimitives.WriteInt32LittleEndian(length, sealedChunk.Length);
        stream.Write(length);
        stream.Write(sealedChunk);
    }

    /// <summary>A terminal's earlier output, oldest first.</summary>
    public IReadOnlyList<string> Lines(string id)
    {
        if (!ValidId().IsMatch(id))
        {
            return [];
        }
        lock (_gate)
        {
            return LinesLocked(id);
        }
    }

    /// <summary>The last lines of a terminal's earlier output (what it already has, so what comes again isn't kept twice).</summary>
    public IReadOnlyList<string> Tail(string id, int count)
    {
        var lines = Lines(id);
        return lines.Count <= count ? lines : lines.Skip(lines.Count - count).ToList();
    }

    private List<string> LinesLocked(string id)
    {
        if (!_read.TryGetValue(id, out var lines))
        {
            lines = Chunks(id).SelectMany(c => c.Lines).ToList();
            _read[id] = lines;
        }
        return lines;
    }

    /// <summary>A file's chunks in order; a damaged or unreadable one is skipped, a cut-off end ignored.</summary>
    private IEnumerable<(long At, byte[] Sealed, string[] Lines)> Chunks(string id)
    {
        byte[] bytes;
        try
        {
            bytes = File.ReadAllBytes(PathOf(id));
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            yield break;
        }
        for (var at = 0; at + LengthSize <= bytes.Length;)
        {
            var length = BinaryPrimitives.ReadInt32LittleEndian(bytes.AsSpan(at, LengthSize));
            if (length <= 0 || at + LengthSize + length > bytes.Length)
            {
                yield break;
            }
            var blob = bytes.AsSpan(at + LengthSize, length).ToArray();
            at += LengthSize + length;
            (long At, string[] Lines)? chunk = null;
            try
            {
                using var doc = JsonDocument.Parse(Sealed.OpenText(Key, blob));
                var root = doc.RootElement;
                var when = root.TryGetProperty(AtField, out var a) && a.TryGetInt64(out var v) ? v : 0;
                var lines = root.TryGetProperty(LinesField, out var l) && l.ValueKind == JsonValueKind.Array
                    ? l.EnumerateArray().Select(e => e.GetString() ?? "").ToArray()
                    : [];
                chunk = (when, lines);
            }
            catch (Exception e) when (e is CryptographicException or JsonException or InvalidOperationException)
            {
                // A damaged chunk: the others are still read.
            }
            if (chunk is { } c)
            {
                yield return (c.At, blob, c.Lines);
            }
        }
    }

    /// <summary>A reopened terminal takes its closed self's earlier output.</summary>
    public void Move(string from, string to)
    {
        if (!ValidId().IsMatch(from) || !ValidId().IsMatch(to) || from == to)
        {
            return;
        }
        lock (_gate)
        {
            if (!File.Exists(PathOf(from)))
            {
                return;
            }
            File.Move(PathOf(from), PathOf(to), overwrite: true);
            _read.Remove(from);
            _read.Remove(to);
        }
    }

    public void Delete(string id)
    {
        if (!ValidId().IsMatch(id))
        {
            return;
        }
        lock (_gate)
        {
            File.Delete(PathOf(id));
            _read.Remove(id);
        }
    }

    /// <summary>The ids that have earlier output.</summary>
    public IReadOnlyList<string> Ids()
    {
        lock (_gate)
        {
            return Directory.Exists(Folder)
                ? Directory.EnumerateFiles(Folder, "*" + Extension).Select(Path.GetFileNameWithoutExtension).OfType<string>().ToList()
                : [];
        }
    }

    /// <summary>Deletes the earlier output of every terminal but these (the open ones, and closed ones still in history).</summary>
    public void KeepOnly(IReadOnlySet<string> ids)
    {
        foreach (var id in Ids().Where(id => !ids.Contains(id)))
        {
            Delete(id);
        }
    }

    /// <summary>Drops chunks kept longer ago than the history setting allows (Forever: none).</summary>
    public void Prune(int retentionDays)
    {
        var cutoff = Retention.CutoffMs(retentionDays);
        foreach (var id in Ids())
        {
            DropBefore(id, cutoff, dryRun: false);
        }
    }

    /// <summary>The size of a terminal's file (0 when it has none).</summary>
    public long Bytes(string id) => ValidId().IsMatch(id) && File.Exists(PathOf(id)) ? new FileInfo(PathOf(id)).Length : 0;

    /// <summary>When a terminal's oldest kept chunk was kept (null when it has none).</summary>
    public long? Oldest(string id)
    {
        if (!ValidId().IsMatch(id))
        {
            return null;
        }
        lock (_gate)
        {
            return Chunks(id).Select(c => (long?)c.At).FirstOrDefault();
        }
    }

    /// <summary>
    /// Drops a terminal's chunks kept before <paramref name="cutoff"/> (unix ms; all of them with long.MaxValue), or with
    /// <paramref name="dryRun"/> only counts them: the lines and bytes that go.
    /// </summary>
    public (long Lines, long Bytes) DropBefore(string id, long cutoff, bool dryRun)
    {
        if (!ValidId().IsMatch(id))
        {
            return (0, 0);
        }
        lock (_gate)
        {
            var chunks = Chunks(id).ToList();
            var old = chunks.Where(c => c.At < cutoff).ToList();
            var gone = (old.Sum(c => (long)c.Lines.Length), old.Sum(c => (long)c.Sealed.Length + LengthSize));
            if (old.Count == 0 || dryRun)
            {
                return gone;
            }
            var kept = chunks.Where(c => c.At >= cutoff).ToList();
            if (kept.Count == 0)
            {
                File.Delete(PathOf(id));
            }
            else
            {
                using var stream = new MemoryStream();
                foreach (var c in kept)
                {
                    WriteChunk(stream, c.Sealed);
                }
                AppPaths.WriteAtomically(PathOf(id), stream.ToArray());
            }
            _read.Remove(id);
            return gone;
        }
    }

    /// <summary>
    /// Every terminal's earlier output with the text in it (not case-sensitive): the lines around its newest matches,
    /// runs that aren't next to each other set apart by <see cref="Gap"/>, and how many lines matched.
    /// </summary>
    public IReadOnlyList<EarlierHit> Search(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return [];
        }
        var found = new List<EarlierHit>();
        foreach (var id in Ids())
        {
            List<string> lines;
            lock (_gate)
            {
                lines = LinesLocked(id);
            }
            var matches = new List<int>();
            for (var i = 0; i < lines.Count; i++)
            {
                if (lines[i].Contains(text, StringComparison.OrdinalIgnoreCase))
                {
                    matches.Add(i);
                }
            }
            if (matches.Count > 0)
            {
                found.Add(new EarlierHit(id, Around(lines, matches.Skip(Math.Max(0, matches.Count - MaxShownHits)).ToList()), matches.Count));
            }
        }
        return found;
    }

    /// <summary>The lines around the matches, oldest first; a gap between runs that don't touch.</summary>
    private static List<string> Around(List<string> lines, List<int> matches)
    {
        var shown = new List<string>();
        var next = 0; // the first line not shown yet
        foreach (var match in matches)
        {
            var from = Math.Max(match - Before, next);
            var to = Math.Min(lines.Count, match + After + 1);
            if (from >= to)
            {
                continue;
            }
            if (shown.Count > 0 && from > next)
            {
                shown.Add(Gap);
            }
            shown.AddRange(lines.Skip(from).Take(to - from));
            next = to;
        }
        return shown;
    }
}
