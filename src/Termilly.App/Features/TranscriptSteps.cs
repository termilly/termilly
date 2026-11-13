using System.Text.Json;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Features;

/// <summary>
/// What Claude did between the prompts in a Claude Code transcript (js/myprompts.js shows them with the prompts):
/// what it wrote (its replies) and the tools it used, each with what it was used on and whether it failed. A
/// subagent's own steps (sidechain lines) and its thinking are left out.
/// </summary>
internal static class TranscriptSteps
{
    /// <summary>At most this many steps are listed (the newest).</summary>
    public const int MaxSteps = 4000;
    /// <summary>A reply longer than this is cut (the list shows its start, its reader all of this).</summary>
    private const int MaxReply = 20000;
    /// <summary>What a tool was used on is cut to this.</summary>
    private const int MaxToolText = 300;

    private const string Assistant = "assistant";
    private const string User = "user";
    private const string TextBlock = "text";
    private const string ToolUse = "tool_use";
    private const string ToolResult = "tool_result";

    /// <summary>A tool's input fields that say best what it was used on, in this order.</summary>
    private static readonly string[] SubjectFields = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "pane", "prompt"];

    private static class Fields
    {
        public const string Type = "type";
        public const string Message = "message";
        public const string Content = "content";
        public const string Text = "text";
        public const string Name = "name";
        public const string Input = "input";
        public const string Id = "id";
        public const string ToolUseId = "tool_use_id";
        public const string IsError = "is_error";
        public const string Timestamp = "timestamp";
        public const string IsSidechain = "isSidechain";
        public const string Uuid = "uuid";
    }

    /// <summary>The steps in a transcript, oldest first, each with what tells it apart; none when it can't be read.</summary>
    public static IReadOnlyList<(AgentStep Step, string Key)> ReadKeyed(string path)
    {
        var steps = new List<(AgentStep Step, string Key, string? ToolId)>();
        var failed = new HashSet<string>(StringComparer.Ordinal);
        TranscriptPrompts.EachLine(path, line => Read(line, steps, failed));
        return steps.Select(s => (s.ToolId is { } id && failed.Contains(id) ? s.Step with { Failed = true } : s.Step, s.Key)).ToList();
    }

    /// <summary>One transcript line: the replies and tool uses it carries, or the tools whose results failed.</summary>
    private static void Read(string line, List<(AgentStep, string, string?)> steps, HashSet<string> failed)
    {
        var isAssistant = line.Contains("\"type\":\"assistant\"", StringComparison.Ordinal);
        if (!isAssistant && !line.Contains("\"is_error\":true", StringComparison.Ordinal))
        {
            return;
        }
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || IsTrue(root, Fields.IsSidechain) ||
                !root.TryGetProperty(Fields.Message, out var message) || message.ValueKind != JsonValueKind.Object ||
                !message.TryGetProperty(Fields.Content, out var content) || content.ValueKind != JsonValueKind.Array)
            {
                return;
            }
            var type = Str(root, Fields.Type);
            if (type == User)
            {
                NoteFailures(content, failed);
            }
            else if (type == Assistant && Str(root, Fields.Timestamp) is { } at)
            {
                AddSteps(content, at, Str(root, Fields.Uuid) ?? at, steps);
            }
        }
        catch (JsonException)
        {
            // A line still being written.
        }
    }

    private static void AddSteps(JsonElement content, string at, string key, List<(AgentStep, string, string?)> steps)
    {
        var index = 0;
        foreach (var block in content.EnumerateArray())
        {
            var type = block.ValueKind == JsonValueKind.Object ? Str(block, Fields.Type) : null;
            if (type == TextBlock && Str(block, Fields.Text)?.Trim() is { Length: > 0 } text)
            {
                steps.Add((new AgentStep(AgentStepKind.Reply, Cut(text, MaxReply), at), $"{key}#{index}", null));
            }
            else if (type == ToolUse && Str(block, Fields.Name) is { } name)
            {
                var subject = block.TryGetProperty(Fields.Input, out var input) ? SubjectOf(input) : null;
                steps.Add((new AgentStep(AgentStepKind.Tool, Cut(subject ?? "", MaxToolText), at, name), $"{key}#{index}", Str(block, Fields.Id)));
            }
            index++;
        }
    }

    private static void NoteFailures(JsonElement content, HashSet<string> failed)
    {
        foreach (var block in content.EnumerateArray())
        {
            if (block.ValueKind == JsonValueKind.Object && Str(block, Fields.Type) == ToolResult && IsTrue(block, Fields.IsError) &&
                Str(block, Fields.ToolUseId) is { } id)
            {
                failed.Add(id);
            }
        }
    }

    /// <summary>What a tool was used on: its command, file, pattern or address, else its first text field.</summary>
    private static string? SubjectOf(JsonElement input)
    {
        if (input.ValueKind != JsonValueKind.Object)
        {
            return null;
        }
        foreach (var field in SubjectFields)
        {
            if (Str(input, field) is { Length: > 0 } value)
            {
                return OneLine(value);
            }
        }
        return input.EnumerateObject().Where(p => p.Value.ValueKind == JsonValueKind.String).Select(p => OneLine(p.Value.GetString() ?? "")).FirstOrDefault();
    }

    private static string OneLine(string s) => string.Join(' ', s.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries)).Trim();

    private static string Cut(string s, int max) => s.Length > max ? s[..max] : s;

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool IsTrue(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}
