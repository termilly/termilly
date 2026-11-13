using System.IO;
using System.IO.Compression;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>One kind of history in the summary: how many, how many lines of output, and its size on disk.</summary>
internal sealed record HistoryKind(string Kind, int Count, long Lines, long Bytes);

/// <summary>
/// A terminal in history and its size: a closed one (its entry's id, name, workspace, shell, when it closed) or an open
/// one (its id; the page knows its name), whose earlier output is what's kept.
/// </summary>
internal sealed record HistoryTerminal(string Id, bool Open, string? Name, string? Workspace, string? Profile, long? ClosedAt, long Bytes);

/// <summary>Commands another PC ran, synced here: which PC and how many.</summary>
internal sealed record HistoryHost(string Host, int Count);

/// <summary>A workspace or a tag in history: its closed terminals and their size, and the commands run in it.</summary>
internal sealed record HistoryGroup(string Name, int Closed, long Bytes, int Commands);

/// <summary>
/// History at a glance (History › Manage): the size on disk, the oldest thing kept, each kind, the largest terminals,
/// and the workspaces and tags to clear by.
/// </summary>
internal sealed record HistoryStats(
    long Total, long? Oldest, string? OldestName, IReadOnlyList<HistoryKind> Kinds, IReadOnlyList<HistoryTerminal> Largest,
    IReadOnlyList<HistoryHost> Hosts, IReadOnlyList<HistoryGroup> Workspaces, IReadOnlyList<HistoryGroup> Tags);

/// <summary>
/// What to clear. The kinds (<see cref="HistoryManager.Kinds"/>) and what's before <see cref="Before"/> (unix ms;
/// null: whenever), only in these workspaces or with these tags when any are given; closed terminals by their ids, and
/// open terminals' earlier output by theirs. <see cref="OutputOnly"/> keeps closed terminals and takes their output.
/// </summary>
internal sealed record HistoryPlan
{
    public long? Before { get; init; }
    public string[]? Kinds { get; init; }
    public string[]? Workspaces { get; init; }
    public string[]? Tags { get; init; }
    public string[]? Ids { get; init; }
    public string[]? EarlierIds { get; init; }
    public bool OutputOnly { get; init; }
}

/// <summary>What a plan clears (or would): closed terminals, when the first and last of them closed, terminals whose earlier output goes, commands, and the size freed.</summary>
internal sealed record HistoryRemoval(int Closed, long? From, long? To, int Earlier, int Commands, int Synced, long Bytes);

/// <summary>
/// History as a whole (Settings › Privacy › History): what's kept and its size, clearing part of it, and exporting
/// it as plain text. Closed terminals (HistoryStore) with their earlier output (EarlierOutput), the open terminals'
/// earlier output, the restart snapshot (SessionSnapshot) and the commands (CommandHistory).
/// </summary>
internal sealed class HistoryManager(Vault vault, ISettingsStore settings, HistoryStore closed, EarlierOutput earlier, CommandHistory commands, SessionSnapshot snapshot)
{
    /// <summary>The kinds of history (the page's HISTORY_KIND).</summary>
    public static class Kinds
    {
        public const string Closed = "closed";
        public const string ClosedEarlier = "closedEarlier";
        public const string Earlier = "earlier";
        public const string Snapshot = "snapshot";
        public const string Commands = "commands";
        public const string Synced = "synced";
    }

    /// <summary>How many of the largest terminals the summary lists.</summary>
    private const int LargestShown = 5;

    private static class Entry
    {
        public const string Id = "id";
        public const string Name = "name";
        public const string Workspace = "wsName";
        public const string Tags = "tags";
        public const string Profile = "profile";
        public const string ClosedAt = "closedAt";
        public const string Lines = "lines";
        public const string Earlier = "earlier";
        public const string NoHistory = "noHistory";
    }

    private static class Command
    {
        public const string Text = "command";
        public const string At = "at";
        public const string Host = "host";
        public const string Workspace = "workspace";
        public const string ExitCode = "exitCode";
        public const string Cwd = "cwd";
        public const string Terminal = "terminal";
    }

    private int Days => settings.Current.Session.HistoryDays;

    /// <summary>The size of everything history keeps on disk: the history folder and the restart snapshot.</summary>
    public long TotalBytes()
    {
        var total = 0L;
        if (Directory.Exists(vault.HistoryDirectory))
        {
            total += new DirectoryInfo(vault.HistoryDirectory).EnumerateFiles("*", SearchOption.AllDirectories).Sum(f => f.Length);
        }
        var snap = new FileInfo(snapshot.FilePath);
        return total + (snap.Exists ? snap.Length : 0);
    }

    /// <summary>What the summary gathers as it goes: the oldest thing, the largest terminals, the workspaces and tags.</summary>
    private sealed class Tally
    {
        public long? Oldest { get; private set; }
        public string? OldestName { get; private set; }
        public List<HistoryTerminal> Largest { get; } = [];
        public Dictionary<string, (int Closed, long Bytes, int Commands)> Workspaces { get; } = new(StringComparer.OrdinalIgnoreCase);
        public Dictionary<string, (int Closed, long Bytes, int Commands)> Tags { get; } = new(StringComparer.OrdinalIgnoreCase);

        public void Older(long? at, string? name)
        {
            if (at is { } a && (Oldest is null || a < Oldest))
            {
                (Oldest, OldestName) = (a, name);
            }
        }

        public static void Add(Dictionary<string, (int Closed, long Bytes, int Commands)> groups, string name, long bytes)
        {
            var known = groups.GetValueOrDefault(name);
            groups[name] = (known.Closed + 1, known.Bytes + bytes, known.Commands);
        }
    }

    /// <summary>The summary; <paramref name="open"/> are the open terminals (whose earlier output isn't a closed terminal's).</summary>
    public HistoryStats Stats(IReadOnlyCollection<string> open)
    {
        var tally = new Tally();
        var closedKind = ClosedKind(tally);
        var earlierKind = EarlierKind(open, tally);
        var (terminals, lines, bytes) = SnapshotSize();
        var (own, synced, hosts) = CommandKinds(tally);
        return new HistoryStats(
            TotalBytes(), tally.Oldest, tally.OldestName,
            [closedKind, earlierKind, new(Kinds.Snapshot, terminals, lines, bytes), own, synced],
            tally.Largest.OrderByDescending(t => t.Bytes).Take(LargestShown).ToList(),
            hosts, Groups(tally.Workspaces), Groups(tally.Tags));
    }

    /// <summary>The closed terminals, each with its earlier output.</summary>
    private HistoryKind ClosedKind(Tally tally)
    {
        var entries = closed.Entries(Days);
        long lines = 0, bytes = 0;
        foreach (var e in entries)
        {
            var node = Parse(e.Json);
            var link = Text(node, Entry.Earlier);
            var size = e.Bytes + (link is null ? 0 : earlier.Bytes(link));
            bytes += size;
            lines += ((node[Entry.Lines] as JsonArray)?.Count ?? 0) + (link is null ? 0 : earlier.Lines(link).Count);
            var name = Text(node, Entry.Name);
            var ws = Text(node, Entry.Workspace);
            tally.Older(link is null ? e.ClosedAt : Math.Min(e.ClosedAt, earlier.Oldest(link) ?? e.ClosedAt), Join(name, ws));
            tally.Largest.Add(new HistoryTerminal(e.Id, false, name, ws, Text(node, Entry.Profile), e.ClosedAt, size));
            if (ws is not null)
            {
                Tally.Add(tally.Workspaces, ws, size);
            }
            foreach (var tag in TagsOf(node))
            {
                Tally.Add(tally.Tags, tag, size);
            }
        }
        return new HistoryKind(Kinds.Closed, entries.Count, lines, bytes);
    }

    /// <summary>The open terminals' earlier output.</summary>
    private HistoryKind EarlierKind(IReadOnlyCollection<string> open, Tally tally)
    {
        long lines = 0, bytes = 0;
        var count = 0;
        foreach (var id in open)
        {
            var size = earlier.Bytes(id);
            if (size == 0)
            {
                continue;
            }
            count++;
            bytes += size;
            lines += earlier.Lines(id).Count;
            tally.Older(earlier.Oldest(id), null);
            tally.Largest.Add(new HistoryTerminal(id, true, null, null, null, null, size));
        }
        return new HistoryKind(Kinds.Earlier, count, lines, bytes);
    }

    /// <summary>The commands run here and those from other PCs (the file's size shared by how much text each has).</summary>
    private (HistoryKind Own, HistoryKind Synced, List<HistoryHost> Hosts) CommandKinds(Tally tally)
    {
        var (own, ownBytes, synced, syncedBytes, hosts) = commands.Read(list =>
        {
            int ownCount = 0, syncedCount = 0;
            long ownSize = 0, syncedSize = 0;
            var byHost = new Dictionary<string, int>();
            foreach (var c in list)
            {
                var size = (long)c.ToJsonString().Length;
                tally.Older(At(c), c[Command.Text].AsText());
                if (c[Command.Host].AsText() is { } host)
                {
                    (syncedCount, syncedSize) = (syncedCount + 1, syncedSize + size);
                    byHost[host] = byHost.GetValueOrDefault(host) + 1;
                    continue;
                }
                (ownCount, ownSize) = (ownCount + 1, ownSize + size);
                if (c[Command.Workspace].AsText() is { } ws)
                {
                    var known = tally.Workspaces.GetValueOrDefault(ws);
                    tally.Workspaces[ws] = known with { Commands = known.Commands + 1 };
                }
            }
            return (ownCount, ownSize, syncedCount, syncedSize, byHost.Select(h => new HistoryHost(h.Key, h.Value)).ToList());
        });
        var file = new FileInfo(Path.Combine(vault.HistoryDirectory, CommandHistory.FileName));
        var total = ownBytes + syncedBytes;
        long Share(long part) => total == 0 || !file.Exists ? 0 : file.Length * part / total;
        return (new HistoryKind(Kinds.Commands, own, 0, Share(ownBytes)), new HistoryKind(Kinds.Synced, synced, 0, Share(syncedBytes)), hosts);
    }

    private static List<HistoryGroup> Groups(Dictionary<string, (int Closed, long Bytes, int Commands)> groups) =>
        groups.Select(g => new HistoryGroup(g.Key, g.Value.Closed, g.Value.Bytes, g.Value.Commands)).OrderByDescending(g => g.Bytes).ToList();

    /// <summary>The restart snapshot: how many terminals, their lines, and its size.</summary>
    private (int Terminals, long Lines, long Bytes) SnapshotSize()
    {
        var file = new FileInfo(snapshot.FilePath);
        if (!file.Exists)
        {
            return (0, 0, 0);
        }
        using var doc = snapshot.Load();
        if (doc is null || !doc.RootElement.TryGetProperty(SessionSnapshot.TabsField, out var tabs) || tabs.ValueKind != JsonValueKind.Object)
        {
            return (0, 0, file.Length);
        }
        var terminals = 0;
        var lines = 0L;
        foreach (var tab in tabs.EnumerateObject())
        {
            terminals++;
            lines += tab.Value.TryGetProperty(Entry.Lines, out var l) && l.ValueKind == JsonValueKind.Array ? l.GetArrayLength() : 0;
        }
        return (terminals, lines, file.Length);
    }

    /// <summary>A plan read once: its kinds, its date, the workspaces and tags it's narrowed to, the closed terminals it names.</summary>
    private sealed class Scope(HistoryPlan plan)
    {
        public HashSet<string> Kinds { get; } = new(plan.Kinds ?? []);
        public long Before { get; } = plan.Before ?? long.MaxValue;
        public HashSet<string> Workspaces { get; } = new(plan.Workspaces ?? [], StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Tags { get; } = new(plan.Tags ?? [], StringComparer.OrdinalIgnoreCase);
        public HashSet<string> Ids { get; } = new(plan.Ids ?? []);
        public bool Narrowed => Workspaces.Count > 0 || Tags.Count > 0;
    }

    /// <summary>Clears what the plan says, or with <paramref name="dryRun"/> only says what it would.</summary>
    public HistoryRemoval Remove(HistoryPlan plan, bool dryRun)
    {
        var scope = new Scope(plan);
        var gone = RemoveClosed(scope, plan.OutputOnly, dryRun);
        var (earlierCount, earlierBytes) = (0, 0L);
        if (scope.Kinds.Contains(Kinds.Earlier))
        {
            foreach (var id in plan.EarlierIds ?? [])
            {
                var (lines, bytes) = earlier.DropBefore(id, scope.Before, dryRun);
                if (lines > 0)
                {
                    (earlierCount, earlierBytes) = (earlierCount + 1, earlierBytes + bytes);
                }
            }
        }
        var (own, ownBytes) = scope.Kinds.Contains(Kinds.Commands) && (!scope.Narrowed || scope.Workspaces.Count > 0)
            ? commands.RemoveWhere(c => c[Command.Host] is null && At(c) < scope.Before
                && (scope.Workspaces.Count == 0 || (c[Command.Workspace].AsText() is { } ws && scope.Workspaces.Contains(ws))), dryRun)
            : (0, 0);
        var (synced, syncedBytes) = scope.Kinds.Contains(Kinds.Synced) && !scope.Narrowed
            ? commands.RemoveWhere(c => c[Command.Host] is not null && At(c) < scope.Before, dryRun)
            : (0, 0);
        return gone with
        {
            Earlier = gone.Earlier + earlierCount, Commands = own, Synced = synced, Bytes = gone.Bytes + earlierBytes + ownBytes + syncedBytes,
        };
    }

    /// <summary>The closed terminals the plan takes (whole, or only their output), and other closed terminals' earlier output by date.</summary>
    private HistoryRemoval RemoveClosed(Scope scope, bool outputOnly, bool dryRun)
    {
        int count = 0, earlierCount = 0;
        long? from = null, to = null;
        var bytes = 0L;
        foreach (var e in closed.Entries(Days))
        {
            var node = Parse(e.Json);
            var link = Text(node, Entry.Earlier);
            var named = scope.Ids.Contains(e.Id);
            var picked = named || (scope.Kinds.Contains(Kinds.Closed) && e.ClosedAt < scope.Before
                && (!scope.Narrowed || (Text(node, Entry.Workspace) is { } ws && scope.Workspaces.Contains(ws)) || TagsOf(node).Any(scope.Tags.Contains)));
            if (picked)
            {
                (count, from, to) = (count + 1, Math.Min(from ?? e.ClosedAt, e.ClosedAt), Math.Max(to ?? e.ClosedAt, e.ClosedAt));
                var keep = outputOnly && !named;
                bytes += (link is null ? 0 : earlier.DropBefore(link, long.MaxValue, dryRun).Bytes) + (keep ? TakeOutput(e, node, dryRun) : e.Bytes);
                if (!dryRun && !keep)
                {
                    closed.Delete(e.Id);
                }
            }
            else if (scope.Kinds.Contains(Kinds.ClosedEarlier) && link is not null && earlier.DropBefore(link, scope.Before, dryRun) is { Lines: > 0 } old)
            {
                (earlierCount, bytes) = (earlierCount + 1, bytes + old.Bytes);
            }
        }
        return new HistoryRemoval(count, from, to, earlierCount, 0, 0, bytes);
    }

    /// <summary>Takes a closed terminal's output and keeps the rest of it (name, tags, workspace): the bytes freed.</summary>
    private long TakeOutput(HistoryStore.Entry e, JsonObject node, bool dryRun)
    {
        node[Entry.Lines] = new JsonArray();
        node[Entry.Earlier] = null;
        node[Entry.NoHistory] = true;
        var json = node.ToJsonString();
        if (!dryRun)
        {
            closed.Replace(e.Id, json);
        }
        return Math.Max(0, e.Bytes - Encoding.UTF8.GetByteCount(json));
    }

    /// <summary>
    /// Writes history to a zip of plain text: each closed terminal (its earlier output, then its lines), each open
    /// terminal's earlier output (named as the page says), and the commands.
    /// </summary>
    public void Export(string path, IReadOnlyDictionary<string, string> openNames)
    {
        using var file = new FileStream(path, FileMode.Create, FileAccess.Write);
        using var zip = new ZipArchive(file, ZipArchiveMode.Create);
        var used = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var e in closed.Entries(Days))
        {
            var node = Parse(e.Json);
            var when = DateTimeOffset.FromUnixTimeMilliseconds(e.ClosedAt).ToLocalTime();
            var lines = new List<string>();
            if (Text(node, Entry.Earlier) is { } link)
            {
                lines.AddRange(earlier.Lines(link));
            }
            lines.AddRange((node[Entry.Lines] as JsonArray ?? []).Select(l => l.AsText() ?? ""));
            var name = $"closed/{when:yyyy-MM-dd HHmm} {Join(Text(node, Entry.Name), Text(node, Entry.Workspace))}";
            Write(zip, Unique(used, name), lines);
        }
        foreach (var (id, name) in openNames)
        {
            var lines = earlier.Lines(id);
            if (lines.Count > 0)
            {
                Write(zip, Unique(used, $"open/{name}"), lines);
            }
        }
        var commandLines = commands.Read(list => list.Select(c =>
        {
            var at = DateTimeOffset.FromUnixTimeMilliseconds(At(c)).ToLocalTime();
            var where = string.Join(" · ", new[] { c[Command.Host].AsText(), c[Command.Workspace].AsText(), c[Command.Terminal].AsText(), c[Command.Cwd].AsText() }.Where(s => !string.IsNullOrEmpty(s)));
            var exit = c[Command.ExitCode].AsLong() is { } code ? $" [exit {code}]" : "";
            return $"{at:yyyy-MM-dd HH:mm:ss}{exit}  {where}\n    {c[Command.Text].AsText()}";
        }).ToList());
        Write(zip, "commands", commandLines);
    }

    private static void Write(ZipArchive zip, string name, IEnumerable<string> lines)
    {
        using var writer = new StreamWriter(zip.CreateEntry(name + AppPaths.TextExtension, CompressionLevel.Optimal).Open(), new UTF8Encoding(false));
        foreach (var line in lines)
        {
            writer.Write(line);
            writer.Write('\n');
        }
    }

    /// <summary>A name for a file in the zip: what a file name can't hold taken out, and numbered when it's taken.</summary>
    private static string Unique(HashSet<string> used, string name)
    {
        var clean = string.Concat(name.Select(ch => Path.GetInvalidFileNameChars().Contains(ch) && ch != '/' ? '_' : ch)).Trim();
        var candidate = clean;
        for (var n = 2; !used.Add(candidate); n++)
        {
            candidate = $"{clean} ({n})";
        }
        return candidate;
    }

    private static JsonObject Parse(string json) => JsonNode.Parse(json) as JsonObject ?? [];

    private static string? Text(JsonObject node, string field) => node[field] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;

    private static IEnumerable<string> TagsOf(JsonObject node) =>
        (node[Entry.Tags] as JsonArray ?? []).Select(t => t is JsonValue v && v.TryGetValue<string>(out var s) ? s : null).OfType<string>();

    private static long At(JsonObject command) => command[Command.At].AsLong() ?? 0;

    private static string Join(string? name, string? workspace) =>
        string.IsNullOrEmpty(workspace) ? name ?? "" : $"{name} · {workspace}";
}
