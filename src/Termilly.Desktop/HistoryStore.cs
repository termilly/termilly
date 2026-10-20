using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// A terminal as the page saves it, in the closed-session history (HistoryStore) and the session snapshot
/// (SessionSnapshot): the fields read here.
/// </summary>
internal static class TerminalRecordFields
{
    public const string Id = "id";
    /// <summary>Its last lines of output.</summary>
    public const string Lines = "lines";
}

/// <summary>
/// Closed terminal sessions (name, tags, shell and saved scrollback), one encrypted file each under
/// %LOCALAPPDATA%\Termilly\history. Entries expire after the user's retention setting, and only the newest
/// <see cref="MaxEntries"/> are kept. Nothing leaves the machine.
/// </summary>
internal sealed partial class HistoryStore(Vault vault)
{
    public const int MaxEntries = 300;
    private const string Extension = ".tmh";

    private string Folder => vault.HistoryDirectory;
    private byte[] Key => vault.Key ?? throw new InvalidOperationException("History is locked.");

    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex ValidId();

    public void Add(JsonElement entry, bool redactSecrets)
    {
        var id = entry.TryGetProperty(TerminalRecordFields.Id, out var idProp) ? idProp.GetString() : null;
        if (id is null || !ValidId().IsMatch(id))
        {
            return;
        }

        var json = entry.GetRawText();
        if (redactSecrets && JsonNode.Parse(json) is JsonObject node && node[TerminalRecordFields.Lines] is JsonArray lines)
        {
            var redacted = SecretRedactor.Redact(lines.Select(l => l?.GetValue<string>() ?? "").ToList());
            node[TerminalRecordFields.Lines] = new JsonArray(redacted.Select(l => (JsonNode?)l).ToArray());
            json = node.ToJsonString();
        }
        AppPaths.WriteAtomically(PathOf(id), Sealed.Seal(Key, json));
    }

    /// <summary>All live entries as a JSON array, newest first. Prunes expired and surplus entries.</summary>
    public JsonDocument List(int retentionDays)
    {
        var entries = new List<(long ClosedAt, string Id, string Json)>();
        if (Directory.Exists(Folder))
        {
            var cutoff = DateTimeOffset.UtcNow.AddDays(-retentionDays).ToUnixTimeMilliseconds();
            foreach (var file in Directory.EnumerateFiles(Folder, "*" + Extension))
            {
                try
                {
                    var json = Sealed.OpenText(Key, File.ReadAllBytes(file));
                    using var doc = JsonDocument.Parse(json);
                    var closedAt = doc.RootElement.TryGetProperty("closedAt", out var c) && c.TryGetInt64(out var v) ? v : 0;
                    if (closedAt < cutoff)
                    {
                        File.Delete(file);
                        continue;
                    }
                    entries.Add((closedAt, Path.GetFileNameWithoutExtension(file), json));
                }
                catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException or CryptographicException)
                {
                    // Skip unreadable entries; they are retried (or expire) next time.
                }
            }
        }

        entries.Sort((a, b) => b.ClosedAt.CompareTo(a.ClosedAt));
        foreach (var surplus in entries.Skip(MaxEntries))
        {
            TryDelete(surplus.Id);
        }

        var array = new StringBuilder("[");
        array.AppendJoin(',', entries.Take(MaxEntries).Select(e => e.Json));
        array.Append(']');
        return JsonDocument.Parse(array.ToString());
    }

    public void Delete(string id)
    {
        if (ValidId().IsMatch(id))
        {
            TryDelete(id);
        }
    }

    public void Clear()
    {
        if (Directory.Exists(Folder))
        {
            foreach (var file in Directory.EnumerateFiles(Folder, "*" + Extension))
            {
                File.Delete(file);
            }
        }
    }

    private string PathOf(string id) => Path.Combine(Folder, id + Extension);

    private void TryDelete(string id)
    {
        try
        {
            File.Delete(PathOf(id));
        }
        catch (IOException)
        {
        }
    }
}
