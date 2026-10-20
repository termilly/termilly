using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// Every command run in a terminal with shell integration: the command line, exit code, duration, folder and
/// terminal. It's one encrypted file next to the closed-session history, kept in memory once read, newest last.
/// Entries expire with the same retention setting, and only the newest <see cref="MaxEntries"/> are kept.
/// Commands are redacted before they're stored when Settings asks for it. Each entry has an id; commands from other
/// PCs (history sync, HistorySync.cs) also have the host that ran them.
/// </summary>
internal sealed class CommandHistory(Vault vault)
{
    public const int MaxEntries = 5000;
    private const int MaxCommandLength = 2000;

    /// <summary>An entry's fields, as the page sends them (js/history.js) and the API and assistant read them.</summary>
    public static class Fields
    {
        public const string Id = "id";
        public const string Command = "command";
        public const string ExitCode = "exitCode";
        public const string DurationMs = "durationMs";
        public const string At = "at";
        public const string Cwd = "cwd";
        public const string Terminal = "terminal";
        public const string Workspace = "workspace";
        /// <summary>The PC another entry was run on (history sync); none for this PC's own.</summary>
        public const string Host = "host";
    }

    private readonly Lock _gate = new();
    private List<JsonObject>? _entries;

    /// <summary>Goes up with every command run here, so sync knows when this PC's file needs writing.</summary>
    public int OwnVersion { get; private set; }

    private string FilePath => Path.Combine(vault.HistoryDirectory, "commands.tmc");
    private byte[] Key => vault.Key ?? throw new InvalidOperationException("History is locked.");

    /// <summary>
    /// Adds a command from the page: { command, exitCode, durationMs, cwd, at, terminal, workspace }. A command
    /// that's empty or too long to be one typed by hand is skipped.
    /// </summary>
    public void Add(JsonElement entry, bool redactSecrets)
    {
        var command = entry.TryGetProperty(Fields.Command, out var c) && c.ValueKind == JsonValueKind.String ? c.GetString()!.Trim() : "";
        if (command.Length == 0 || command.Length > MaxCommandLength)
        {
            return;
        }
        var node = new JsonObject
        {
            [Fields.Id] = Guid.NewGuid().ToString("N"),
            [Fields.Command] = redactSecrets ? SecretRedactor.Redact(command) : command,
            [Fields.ExitCode] = Number(entry, Fields.ExitCode),
            [Fields.DurationMs] = Number(entry, Fields.DurationMs),
            [Fields.At] = Number(entry, Fields.At) ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            [Fields.Cwd] = Text(entry, Fields.Cwd),
            [Fields.Terminal] = Text(entry, Fields.Terminal),
            [Fields.Workspace] = Text(entry, Fields.Workspace),
        };
        lock (_gate)
        {
            var entries = Load();
            entries.Add(node);
            if (entries.Count > MaxEntries)
            {
                entries.RemoveRange(0, entries.Count - MaxEntries);
            }
            Save(entries);
            OwnVersion++;
        }
    }

    /// <summary>The commands run on this PC (not ones synced from others), oldest first.</summary>
    public List<JsonObject> OwnEntries()
    {
        lock (_gate)
        {
            return Load().Where(e => e[Fields.Host] is null).Select(e => (JsonObject)e.DeepClone()).ToList();
        }
    }

    /// <summary>
    /// Adds commands another PC ran (from its sync file), skipping ids already here. Returns how many were new.
    /// </summary>
    public int Import(IEnumerable<JsonObject> incoming, string host)
    {
        lock (_gate)
        {
            var entries = Load();
            var known = entries.Select(e => e[Fields.Id]?.GetValue<string>()).OfType<string>().ToHashSet();
            var added = 0;
            foreach (var entry in incoming)
            {
                if (entry[Fields.Id]?.GetValue<string>() is not { } id || entry[Fields.Command] is null || !known.Add(id))
                {
                    continue;
                }
                var copy = (JsonObject)entry.DeepClone();
                copy[Fields.Host] = host;
                entries.Add(copy);
                added++;
            }
            if (added > 0)
            {
                entries.Sort((a, b) => (a[Fields.At]?.GetValue<long>() ?? 0).CompareTo(b[Fields.At]?.GetValue<long>() ?? 0));
                if (entries.Count > MaxEntries)
                {
                    entries.RemoveRange(0, entries.Count - MaxEntries);
                }
                Save(entries);
            }
            return added;
        }
    }

    /// <summary>The commands from the last <paramref name="retentionDays"/> days, newest first, as a JSON array.</summary>
    public string List(int retentionDays)
    {
        var cutoff = DateTimeOffset.UtcNow.AddDays(-retentionDays).ToUnixTimeMilliseconds();
        lock (_gate)
        {
            var entries = Load();
            var expired = entries.RemoveAll(e => (e[Fields.At]?.GetValue<long>() ?? 0) < cutoff);
            if (expired > 0)
            {
                Save(entries);
            }
            return new JsonArray(entries.AsEnumerable().Reverse().Select(e => (JsonNode)e.DeepClone()).ToArray()).ToJsonString();
        }
    }

    public void Clear()
    {
        lock (_gate)
        {
            _entries = [];
            if (File.Exists(FilePath))
            {
                File.Delete(FilePath);
            }
        }
    }

    /// <summary>Forgets what's in memory (after the vault changed key), so the next use reads the file again.</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _entries = null;
        }
    }

    private List<JsonObject> Load()
    {
        if (_entries is not null)
        {
            return _entries;
        }
        _entries = [];
        try
        {
            if (File.Exists(FilePath) && JsonNode.Parse(Sealed.OpenText(Key, File.ReadAllBytes(FilePath))) is JsonArray array)
            {
                _entries.AddRange(array.OfType<JsonObject>().Select(e => (JsonObject)e.DeepClone()));
                // Entries from before sync had no id; they get one for good, so other PCs don't see them twice.
                var missing = _entries.Where(e => e[Fields.Id] is null).ToList();
                foreach (var entry in missing)
                {
                    entry[Fields.Id] = Guid.NewGuid().ToString("N");
                }
                if (missing.Count > 0)
                {
                    Save(_entries);
                }
            }
        }
        catch (Exception e) when (e is IOException or JsonException or CryptographicException or UnauthorizedAccessException)
        {
            // Unreadable (sealed with a key "Start fresh" replaced): start over rather than fail every command.
        }
        return _entries;
    }

    private void Save(List<JsonObject> entries) =>
        AppPaths.WriteAtomically(FilePath, Sealed.Seal(Key, new JsonArray(entries.Select(e => (JsonNode)e.DeepClone()).ToArray()).ToJsonString()));

    private static long? Number(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : null;

    private static string? Text(JsonElement entry, string name) =>
        entry.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;
}
