using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// Command history search for the API (termilly history, the MCP server). Commands are always redacted here,
/// whatever the history setting, because the caller may be an agent sending them on.
/// </summary>
internal static class ApiHistory
{
    public const int MaxResults = 200;

    /// <param name="historyJson">CommandHistory.List's array, newest first.</param>
    /// <param name="request">{ query?, failed?, in?, limit? }</param>
    public static JsonArray Search(string historyJson, JsonObject request)
    {
        var words = (request[ApiFields.Query]?.ToString() ?? "").ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        bool? failed = request[ApiFields.Failed] is JsonValue f && f.TryGetValue<bool>(out var b) ? b : null;
        var folder = request[ApiFields.In]?.ToString()?.ToLowerInvariant();
        var limit = request[ApiFields.Limit] is JsonValue l && l.TryGetValue<int>(out var n) ? Math.Clamp(n, 1, MaxResults) : ApiDefaults.HistoryLimit;

        var results = new JsonArray();
        foreach (var entry in JsonNode.Parse(historyJson)?.AsArray().OfType<JsonObject>() ?? [])
        {
            var command = SecretRedactor.Redact(entry[ApiFields.Command]?.ToString() ?? "");
            var exitCode = entry[ApiFields.ExitCode] is JsonValue c && c.TryGetValue<long>(out var code) ? code : (long?)null;
            if (failed is { } wantFailed && (exitCode is not null and not 0) != wantFailed)
            {
                continue;
            }
            if (folder is { Length: > 0 } && !(entry[ApiFields.Cwd]?.ToString() ?? "").Contains(folder, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (!words.All(w => command.Contains(w, StringComparison.OrdinalIgnoreCase)))
            {
                continue;
            }

            var copy = (JsonObject)entry.DeepClone();
            copy[ApiFields.Command] = command;
            results.Add(copy);
            if (results.Count >= limit)
            {
                break;
            }
        }
        return results;
    }
}
