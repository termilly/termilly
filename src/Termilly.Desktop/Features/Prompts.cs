using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>My prompts (js/myprompts.js): what the user asked Claude Code in a terminal, from its sessions' transcripts.</summary>
internal sealed class PromptsHandler(PageChannel page) : IMessageHandler
{
    /// <summary>At most this many sessions are read for one terminal.</summary>
    private const int MaxSessions = 20;

    public void Register(MessageRouter router) =>
        router.On<FromPage.PromptsList>(m => Task.Run(() => List(m)));

    private void List(FromPage.PromptsList m)
    {
        var projects = ClaudeUsageTracker.ProjectsDirectory();
        var prompts = new List<AgentPrompt>();
        foreach (var session in (m.Sessions ?? []).Distinct().TakeLast(MaxSessions))
        {
            if (ClaudeUsageTracker.FindTranscript(projects, session) is { } path)
            {
                prompts.AddRange(TranscriptPrompts.Read(path));
            }
        }
        prompts.Sort((a, b) => string.CompareOrdinal(a.At, b.At));
        page.Post(new ToPage.PromptsListed(m.RequestId, prompts.TakeLast(TranscriptPrompts.MaxPrompts).ToList()));
    }
}

/// <summary>
/// The prompts in a Claude Code transcript: the user's own messages, without tool results, slash commands' output,
/// shell commands (!), notices Claude Code adds, or the summary a compaction starts with.
/// </summary>
internal static partial class TranscriptPrompts
{
    /// <summary>At most this many prompts are listed (the newest).</summary>
    public const int MaxPrompts = 2000;
    /// <summary>A prompt longer than this is cut (the list shows its start; the terminal has the rest).</summary>
    public const int MaxText = 4000;
    /// <summary>A line this long is a pasted image or a file, read past.</summary>
    private const int MaxLine = 4 << 20;

    private const string User = "user";
    private const string Text = "text";
    private const string ToolResult = "tool_result";

    /// <summary>What Claude Code writes as the user but the user didn't type.</summary>
    private static readonly string[] NotTyped =
    [
        "<command-name>", "<command-message>", "<local-command-", "<bash-input>", "<bash-stdout>", "<bash-stderr>",
        "<task-notification>", "<system-reminder>", "[Request interrupted", "Caveat:",
    ];

    private static class Fields
    {
        public const string Type = "type";
        public const string Message = "message";
        public const string Content = "content";
        public const string Text = "text";
        public const string Timestamp = "timestamp";
        public const string IsMeta = "isMeta";
        public const string IsSidechain = "isSidechain";
        public const string IsCompactSummary = "isCompactSummary";
        public const string ToolUseResult = "toolUseResult";
    }

    /// <summary>The prompts in a transcript, oldest first; none when it can't be read.</summary>
    public static IReadOnlyList<AgentPrompt> Read(string path)
    {
        var prompts = new List<AgentPrompt>();
        try
        {
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(stream, Encoding.UTF8);
            while (reader.ReadLine() is { } line)
            {
                if (line.Length <= MaxLine && line.Contains("\"type\":\"user\"", StringComparison.Ordinal) && Prompt(line) is { } prompt)
                {
                    prompts.Add(prompt);
                }
            }
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // A transcript that went away, or can't be read: no prompts from it.
        }
        return prompts;
    }

    /// <summary>One transcript line's prompt; null for any other line.</summary>
    public static AgentPrompt? Prompt(string line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Str(root, Fields.Type) != User || IsTrue(root, Fields.IsMeta) ||
                IsTrue(root, Fields.IsSidechain) || IsTrue(root, Fields.IsCompactSummary) || root.TryGetProperty(Fields.ToolUseResult, out _) ||
                !root.TryGetProperty(Fields.Message, out var message) || message.ValueKind != JsonValueKind.Object ||
                !message.TryGetProperty(Fields.Content, out var content) || TextOf(content) is not { } text ||
                Str(root, Fields.Timestamp) is not { } at)
            {
                return null;
            }
            text = PastedTag().Replace(text, "").Trim();
            return text.Length == 0 || NotTyped.Any(n => text.StartsWith(n, StringComparison.Ordinal))
                ? null
                : new AgentPrompt(text.Length > MaxText ? text[..MaxText] : text, at);
        }
        catch (JsonException)
        {
            return null; // a line still being written
        }
    }

    /// <summary>A message's text: a string, or its text blocks (none when it carries a tool's result).</summary>
    private static string? TextOf(JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            return content.GetString();
        }
        if (content.ValueKind != JsonValueKind.Array)
        {
            return null;
        }
        var parts = new List<string>();
        foreach (var block in content.EnumerateArray())
        {
            var type = block.ValueKind == JsonValueKind.Object ? Str(block, Fields.Type) : null;
            if (type == ToolResult)
            {
                return null;
            }
            if (type == Text && Str(block, Fields.Text) is { } part)
            {
                parts.Add(part);
            }
        }
        return parts.Count > 0 ? string.Join("\n", parts) : null;
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool IsTrue(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    /// <summary>The tags a pasted text is wrapped in (the text itself stays).</summary>
    [GeneratedRegex("</?pasted_content[^>]*>")]
    private static partial Regex PastedTag();
}
