using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Shared;

namespace Termilly.Desktop.Features;

/// <summary>
/// A Claude Code transcript (~/.claude/projects/&lt;folder&gt;/&lt;session&gt;.jsonl) read for the compact view: the user's
/// prompts, Claude's words and thinking, a line per tool (its result fills the line in when it lands), and the end of
/// each turn. A subagent's own steps (sidechain lines) and Claude Code's bookkeeping are left out.
/// </summary>
internal sealed class CompactClaude : ICompactReader
{
    private static class Fields
    {
        public const string Type = "type";
        public const string Subtype = "subtype";
        public const string Message = "message";
        public const string Content = "content";
        public const string Text = "text";
        public const string Thinking = "thinking";
        public const string Name = "name";
        public const string Input = "input";
        public const string Id = "id";
        public const string ToolUseId = "tool_use_id";
        public const string IsError = "is_error";
        public const string IsSidechain = "isSidechain";
        public const string IsMeta = "isMeta";
        public const string IsCompactSummary = "isCompactSummary";
        public const string Uuid = "uuid";
        public const string Cwd = "cwd";
        public const string DurationMs = "durationMs";
        public const string ToolUseResult = "toolUseResult";
    }

    private static class Types
    {
        public const string User = "user";
        public const string Assistant = "assistant";
        public const string System = "system";
        public const string TurnDuration = "turn_duration";
        public const string ToolUse = "tool_use";
        public const string ToolResult = "tool_result";
    }

    /// <summary>How Claude Code marks a turn the user stopped, at the start of the user line it writes.</summary>
    private const string InterruptedMark = "[Request interrupted";
    /// <summary>A slash command the user typed is written as tags; its name is in this one.</summary>
    private const string CommandNameOpen = "<command-name>";
    private const string CommandNameClose = "</command-name>";

    /// <summary>Lines worth parsing say one of these; the rest (requests, snapshots, settings) are passed over unread.</summary>
    private static readonly byte[][] Wanted = ["\"type\":\"user\""u8.ToArray(), "\"type\":\"assistant\""u8.ToArray(), "\"turn_duration\""u8.ToArray()];

    /// <summary>The calls waiting for their results, by id; a call leaves once its result is read.</summary>
    private readonly Dictionary<string, ClaudeCall> _calls = new(StringComparer.Ordinal);

    public void Read(ReadOnlySpan<byte> line, CompactLog log)
    {
        if (!Wants(line) || CompactJson.Parse(line) is not { } root || root[Fields.IsSidechain].AsBool() == true)
        {
            return;
        }
        var key = root[Fields.Uuid].AsText();
        if (key is null)
        {
            return;
        }
        var cwd = root[Fields.Cwd].AsText();
        switch (root[Fields.Type].AsText())
        {
            case Types.Assistant:
                ReadAssistant(root, key, cwd, log);
                break;
            case Types.User when root[Fields.IsMeta].AsBool() != true && root[Fields.IsCompactSummary].AsBool() != true:
                ReadUser(root, key, log);
                break;
            case Types.System when root[Fields.Subtype].AsText() == Types.TurnDuration && root[Fields.DurationMs].AsLong() is { } ms:
                log.Put(new CompactLine(key, CompactKinds.End, "", Detail: CompactText.Duration(ms)));
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

    /// <summary>Claude's words, thinking and tool calls: a line each.</summary>
    private void ReadAssistant(JsonObject root, string key, string? cwd, CompactLog log)
    {
        if (root[Fields.Message]?[Fields.Content] is not JsonArray blocks)
        {
            return;
        }
        var i = 0;
        foreach (var block in blocks.OfType<JsonObject>())
        {
            var part = $"{key}:{i++}";
            switch (block[Fields.Type].AsText())
            {
                case Fields.Text when block[Fields.Text].AsText() is { } text && !string.IsNullOrWhiteSpace(text):
                    log.Put(new CompactLine(part, CompactKinds.Reply, CompactText.Cut(text.Trim(), CompactText.MaxWords)));
                    break;
                case Fields.Thinking when block[Fields.Thinking].AsText() is { } thought && !string.IsNullOrWhiteSpace(thought):
                    log.Put(new CompactLine(part, CompactKinds.Thinking, CompactText.Cut(thought.Trim(), CompactText.MaxWords)));
                    break;
                case Types.ToolUse when block[Fields.Id].AsText() is { } id && block[Fields.Name].AsText() is { } name:
                    // A line whose result came already (the transcript repeats a call) keeps it.
                    if (log.Find(id) is not { Done: true })
                    {
                        var call = ClaudeToolLine.Call(name, block[Fields.Input] as JsonObject, cwd);
                        _calls[id] = call;
                        ForgetLost(log);
                        log.Put(new CompactLine(id, CompactKinds.Tool, call.Subject, call.Verb, Done: false));
                    }
                    break;
            }
        }
    }

    /// <summary>
    /// Calls whose result never came (a turn stopped mid-call) are forgotten once there are more waiting than the view
    /// keeps lines: those whose line is gone.
    /// </summary>
    private void ForgetLost(CompactLog log)
    {
        if (_calls.Count <= CompactLimits.MaxLines)
        {
            return;
        }
        foreach (var lost in _calls.Keys.Where(k => log.Find(k) is null).ToList())
        {
            _calls.Remove(lost);
        }
    }

    /// <summary>What the user typed (a prompt, or a slash command), a turn they stopped, or tools' results.</summary>
    private void ReadUser(JsonObject root, string key, CompactLog log)
    {
        var content = root[Fields.Message]?[Fields.Content];
        if (content is JsonArray blocks && blocks.OfType<JsonObject>().Any(b => b[Fields.Type].AsText() == Types.ToolResult))
        {
            foreach (var result in blocks.OfType<JsonObject>().Where(b => b[Fields.Type].AsText() == Types.ToolResult))
            {
                ReadResult(result, root[Fields.ToolUseResult], log);
            }
            return;
        }
        var text = CompactJson.Texts(content, Fields.Text).Trim();
        if (text.StartsWith(InterruptedMark, StringComparison.Ordinal))
        {
            log.Put(new CompactLine(key, CompactKinds.Interrupted, ""));
        }
        else if (Prompt(text) is { Length: > 0 } prompt)
        {
            log.Put(new CompactLine(key, CompactKinds.Prompt, CompactText.Cut(prompt, CompactText.MaxWords)));
        }
    }

    /// <summary>The prompt as the user wrote it; a slash command by its name; Claude Code's own notes (tags) none.</summary>
    private static string? Prompt(string text)
    {
        if (!text.StartsWith('<'))
        {
            return text;
        }
        var start = text.IndexOf(CommandNameOpen, StringComparison.Ordinal);
        var end = text.IndexOf(CommandNameClose, StringComparison.Ordinal);
        return start >= 0 && end > start ? text[(start + CommandNameOpen.Length)..end].Trim() : null;
    }

    /// <summary>A tool's result: its line says what came of it, or why it failed.</summary>
    private void ReadResult(JsonObject result, JsonNode? details, CompactLog log)
    {
        if (result[Fields.ToolUseId].AsText() is not { } id || !_calls.Remove(id, out var call))
        {
            return;
        }
        var failed = result[Fields.IsError].AsBool() == true;
        var output = CompactJson.Texts(result[Fields.Content]);
        var line = failed
            ? new CompactLine(id, CompactKinds.Tool, call.Subject, call.Verb, CompactText.Reason(output), Failed: true)
            : ClaudeToolLine.Result(id, call, details as JsonObject, output);
        log.Put(line);
    }
}
