using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Shared;

namespace Termilly.Desktop.Features;

/// <summary>
/// A Codex rollout (~/.codex/sessions/YYYY/MM/DD/rollout-*-&lt;session&gt;.jsonl) read for the compact view, from the
/// items Codex records as each completes: the user's prompts, its words and reasoning summaries, its commands (sorted
/// into Read, Search, List, Test and Run as Codex itself parsed them), its file changes (a line per file), MCP calls and
/// web searches, and the end of each turn.
/// </summary>
internal sealed class CompactCodex : ICompactReader
{
    private static class Fields
    {
        public const string Type = "type";
        public const string Payload = "payload";
        public const string Item = "item";
        public const string Id = "id";
        public const string Cwd = "cwd";
        public const string Content = "content";
        public const string SummaryText = "summary_text";
        public const string ParsedCmd = "parsed_cmd";
        public const string Cmd = "cmd";
        public const string Name = "name";
        public const string Path = "path";
        public const string Query = "query";
        public const string ExitCode = "exit_code";
        public const string Output = "aggregated_output";
        public const string Status = "status";
        public const string Changes = "changes";
        public const string UnifiedDiff = "unified_diff";
        public const string Server = "server";
        public const string Tool = "tool";
        public const string Kind = "kind";
        public const string Action = "action";
        public const string Queries = "queries";
        public const string TurnId = "turn_id";
        public const string DurationMs = "duration_ms";
        public const string Timestamp = "timestamp";
    }

    private static class Types
    {
        public const string SessionMeta = "session_meta";
        public const string EventMsg = "event_msg";
        public const string ItemCompleted = "item_completed";
        public const string TaskComplete = "task_complete";
        public const string TurnAborted = "turn_aborted";
        public const string UserMessage = "UserMessage";
        public const string AgentMessage = "AgentMessage";
        public const string Reasoning = "Reasoning";
        public const string Command = "CommandExecution";
        public const string FileChange = "FileChange";
        public const string McpToolCall = "McpToolCall";
        public const string Extension = "Extension";
        public const string WebSearch = "web.search";
        public const string Failed = "failed";
    }

    /// <summary>How Codex sorted a command (parsed_cmd's type).</summary>
    private static class Parsed
    {
        public const string Read = "read";
        public const string Search = "search";
        public const string ListFiles = "list_files";
    }

    /// <summary>A file change's kind.</summary>
    private static class Change
    {
        public const string Add = "add";
        public const string Delete = "delete";
    }

    private static readonly byte[][] Wanted =
        ["\"item_completed\""u8.ToArray(), "\"task_complete\""u8.ToArray(), "\"turn_aborted\""u8.ToArray(), "\"session_meta\""u8.ToArray()];

    /// <summary>The session's folder: paths in it read relative to it.</summary>
    private string? _cwd;

    public void Read(ReadOnlySpan<byte> line, CompactLog log)
    {
        if (!Wants(line) || CompactJson.Parse(line) is not { } root || root[Fields.Payload] is not JsonObject payload)
        {
            return;
        }
        var type = root[Fields.Type].AsText();
        if (type == Types.SessionMeta)
        {
            _cwd = payload[Fields.Cwd].AsText();
            return;
        }
        if (type != Types.EventMsg)
        {
            return;
        }
        switch (payload[Fields.Type].AsText())
        {
            case Types.ItemCompleted when payload[Fields.Item] is JsonObject item && item[Fields.Id].AsText() is { } id:
                ReadItem(item, id, log);
                break;
            case Types.TaskComplete when payload[Fields.TurnId].AsText() is { } turn:
                var ms = payload[Fields.DurationMs].AsLong();
                log.Put(new CompactLine($"end:{turn}", CompactKinds.End, "", Detail: ms is null ? null : CompactText.Duration(ms.Value)));
                break;
            case Types.TurnAborted:
                log.Put(new CompactLine($"aborted:{payload[Fields.TurnId].AsText() ?? root[Fields.Timestamp].AsText()}", CompactKinds.Interrupted, ""));
                break;
        }
    }

    private static bool Wants(ReadOnlySpan<byte> line)
    {
        foreach (var mark in Wanted)
        {
            if (line.IndexOf(mark) >= 0)
            {
                return true;
            }
        }
        return false;
    }

    private void ReadItem(JsonObject item, string id, CompactLog log)
    {
        switch (item[Fields.Type].AsText())
        {
            case Types.UserMessage:
                Words(log, id, CompactKinds.Prompt, CompactJson.Texts(item[Fields.Content]));
                break;
            case Types.AgentMessage:
                Words(log, id, CompactKinds.Reply, CompactJson.Texts(item[Fields.Content]));
                break;
            case Types.Reasoning:
                Words(log, id, CompactKinds.Thinking, string.Join("\n", (item[Fields.SummaryText] as JsonArray)?.Select(s => s.AsText()).OfType<string>() ?? []));
                break;
            case Types.Command:
                log.Put(CommandLine(item, id));
                break;
            case Types.FileChange:
                FileLines(item, id, log);
                break;
            case Types.McpToolCall:
                var failed = item[Fields.Status].AsText() == Types.Failed;
                log.Put(new CompactLine(id, CompactKinds.Tool, $"{item[Fields.Server].AsText()}: {item[Fields.Tool].AsText()}", CompactVerbs.Mcp, failed ? CompactText.Failed : CompactText.Done, failed));
                break;
            case Types.Extension when item[Fields.Kind].AsText() == Types.WebSearch:
                var queries = (item[Fields.Action]?[Fields.Queries] as JsonArray)?.Select(q => q.AsText()).OfType<string>().ToList();
                var query = queries is { Count: > 0 } ? string.Join("; ", queries) : item[Fields.Query].AsText() ?? "";
                log.Put(new CompactLine(id, CompactKinds.Tool, CompactText.Cut(query, CompactText.MaxSubject), CompactVerbs.Web, "searched"));
                break;
        }
    }

    private static void Words(CompactLog log, string id, string kind, string text)
    {
        if (!string.IsNullOrWhiteSpace(text))
        {
            log.Put(new CompactLine(id, kind, CompactText.Cut(text.Trim(), CompactText.MaxWords)));
        }
    }

    /// <summary>A command, as Codex parsed it: a read, a search or a listing by what it worked on; anything else as typed.</summary>
    private CompactLine CommandLine(JsonObject item, string id)
    {
        var parsed = (item[Fields.ParsedCmd] as JsonArray)?.OfType<JsonObject>().FirstOrDefault();
        var command = CompactText.FirstLine(parsed?[Fields.Cmd].AsText());
        var output = item[Fields.Output].AsText();
        var exit = item[Fields.ExitCode].AsLong();
        var path = CompactText.Relative(parsed?[Fields.Path].AsText(), _cwd);
        var (verb, subject, detail) = parsed?[Fields.Type].AsText() switch
        {
            Parsed.Read => (CompactVerbs.Read, path.Length > 0 ? path : parsed[Fields.Name].AsText() ?? command, CompactText.LineCount(CompactText.Lines(output))),
            Parsed.Search => (CompactVerbs.Search, Searched(parsed[Fields.Query].AsText(), path, command), CompactText.HitCount(CompactText.Entries(output))),
            Parsed.ListFiles => (CompactVerbs.List, path.Length > 0 ? path : command, CompactText.Count(CompactText.Entries(output), "entry", "entries")),
            _ => (CompactText.CommandVerb(command), command, CompactText.Output(command, output)),
        };
        // A search that finds nothing ends with 1 (rg, grep): that's a result, not a failure.
        var failed = exit is { } code && code != 0 && !(verb == CompactVerbs.Search && code == 1);
        return failed
            ? new CompactLine(id, CompactKinds.Tool, subject, verb, (verb == CompactVerbs.Test ? CompactText.TestResult(output) : null) ?? $"exit {exit}", Failed: true)
            : new CompactLine(id, CompactKinds.Tool, subject, verb, detail);
    }

    private static string Searched(string? query, string path, string command)
    {
        if (string.IsNullOrEmpty(query))
        {
            return command;
        }
        return path.Length > 0 ? $"\"{query}\" in {path}" : $"\"{query}\"";
    }

    /// <summary>A file change: a line per file, Write for a new one, else Edit with its counts.</summary>
    private void FileLines(JsonObject item, string id, CompactLog log)
    {
        if (item[Fields.Changes] is not JsonObject changes)
        {
            return;
        }
        var failed = item[Fields.Status].AsText() == Types.Failed;
        foreach (var (path, change) in changes)
        {
            var file = CompactText.Relative(path, _cwd);
            var kind = change?[Fields.Type].AsText();
            var (verb, detail) = kind switch
            {
                Change.Add => (CompactVerbs.Write, $"new · {CompactText.LineCount(CompactText.Lines(change?[Fields.Content].AsText()))}"),
                Change.Delete => (CompactVerbs.Edit, "deleted"),
                _ => (CompactVerbs.Edit, Counts(change?[Fields.UnifiedDiff].AsText()) ?? "changed"),
            };
            log.Put(new CompactLine($"{id}:{path}", CompactKinds.Tool, file, verb, failed ? CompactText.Failed : detail, failed));
        }
    }

    private static string? Counts(string? diff)
    {
        var (added, removed) = CompactText.DiffCounts(diff);
        return CompactText.Changes(added, removed);
    }
}
