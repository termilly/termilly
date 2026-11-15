using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Shared;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Features;

/// <summary>
/// A session's lines in the compact view, oldest first, at most <see cref="CompactLimits.MaxLines"/> (the oldest go). A line added
/// again under its key replaces it in place (a tool's result arrived); what changed since the last
/// <see cref="TakeChanged"/> is kept, in order, for the next message to the page.
/// </summary>
internal sealed class CompactLog
{
    private readonly Dictionary<string, CompactLine> _lines = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _order = new();
    private readonly List<string> _changed = [];
    private readonly HashSet<string> _changedKeys = new(StringComparer.Ordinal);

    public int Count => _lines.Count;

    /// <summary>Adds a line, or replaces the one with its key.</summary>
    public void Put(CompactLine line)
    {
        if (!_lines.ContainsKey(line.Key))
        {
            _order.AddLast(line.Key);
            if (_order.Count > CompactLimits.MaxLines && _order.First is { } oldest)
            {
                _lines.Remove(oldest.Value);
                _order.RemoveFirst();
            }
        }
        _lines[line.Key] = line;
        if (_changedKeys.Add(line.Key))
        {
            _changed.Add(line.Key);
        }
    }

    /// <summary>The line with this key, if it's still kept.</summary>
    public CompactLine? Find(string key) => _lines.GetValueOrDefault(key);

    /// <summary>Every line kept, oldest first.</summary>
    public IReadOnlyList<CompactLine> All() => _order.Select(k => _lines[k]).ToList();

    /// <summary>The lines added or changed since the last call, in the order they first changed (none gone since).</summary>
    public IReadOnlyList<CompactLine> TakeChanged()
    {
        var changed = _changed.Where(_lines.ContainsKey).Select(k => _lines[k]).ToList();
        _changed.Clear();
        _changedKeys.Clear();
        return changed;
    }

    /// <summary>Forgets what changed (the page is about to get every line).</summary>
    public void ClearChanged()
    {
        _changed.Clear();
        _changedKeys.Clear();
    }
}

/// <summary>Reads one kind of session file (Claude Code's transcript, Codex's rollout) into a <see cref="CompactLog"/>.</summary>
internal interface ICompactReader
{
    /// <summary>One whole line of the file; one that isn't JSON, or not about the session's steps, is passed over.</summary>
    void Read(ReadOnlySpan<byte> line, CompactLog log);

    /// <summary>After the lines read at once: anything that needs the reading done first (by default, nothing).</summary>
    void Settle(CompactLog log)
    {
    }
}

/// <summary>What the readers share: parsing a line that may not be JSON, and reading its fields.</summary>
internal static class CompactJson
{
    /// <summary>The line as a JSON object; null when it isn't one.</summary>
    public static JsonObject? Parse(ReadOnlySpan<byte> line)
    {
        try
        {
            var reader = new Utf8JsonReader(line);
            return JsonNode.Parse(ref reader) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>The text pieces of an array of content blocks ({type, text}) joined, or a plain string as it is.</summary>
    public static string Texts(JsonNode? content, params string[] types)
    {
        if (content is JsonValue)
        {
            return content.AsText() ?? "";
        }
        if (content is not JsonArray parts)
        {
            return "";
        }
        var texts = parts.OfType<JsonObject>()
            .Where(p => types.Length == 0 || types.Contains(p["type"].AsText()))
            .Select(p => p["text"].AsText())
            .OfType<string>();
        return string.Join("\n", texts);
    }
}
