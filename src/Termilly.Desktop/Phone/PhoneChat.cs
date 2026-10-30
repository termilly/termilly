using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Phone;

/// <summary>One message of a Claude Code conversation as the phone shows it: who (<see cref="ChatTranscript.Roles"/>) and what.</summary>
internal sealed record ChatEntry(string Role, string Text);

/// <summary>
/// A Claude Code conversation as the phone's chat view shows it, read from the session's transcript as it grows: what
/// you asked, what Claude said, and a line per tool it ran. Its own stream, so it wraps to the phone's width whatever
/// the PC's terminal is; thinking, tool output and Claude Code's own notes are left out.
/// </summary>
internal sealed class ChatTranscript
{
    /// <summary>The messages kept (the phone shows the latest), and how long one may be.</summary>
    private const int Keep = 400;
    private const int MaxText = 8000;
    private const int MaxTool = 240;
    /// <summary>A line this long is a tool's output or a file, never a message: skipped unread.</summary>
    private const int MaxLine = 4 << 20;

    public static class Roles
    {
        public const string You = "you";
        public const string Claude = "claude";
        public const string Tool = "tool";
    }

    /// <summary>The transcript fields read.</summary>
    private static class Fields
    {
        public const string Type = "type";
        public const string Message = "message";
        public const string Content = "content";
        public const string Text = "text";
        public const string Name = "name";
        public const string Input = "input";
        public const string IsSidechain = "isSidechain";
        public const string IsMeta = "isMeta";
        public const string IsCompactSummary = "isCompactSummary";
    }

    /// <summary>The kinds of line and of content block read.</summary>
    private static class Kinds
    {
        public const string User = "user";
        public const string Assistant = "assistant";
        public const string Text = "text";
        public const string ToolUse = "tool_use";
    }

    /// <summary>What a tool's line shows of its input: the first of these it has.</summary>
    private static readonly string[] ToolDetail = ["command", "file_path", "notebook_path", "path", "pattern", "url", "query", "description", "prompt"];

    private readonly TranscriptTail _tail;
    private readonly List<ChatEntry> _entries = [];
    private readonly Lock _lock = new();
    /// <summary>The number of the first message kept (they're numbered from 1 as they're read).</summary>
    private long _first = 1;

    public ChatTranscript(string path) => _tail = new TranscriptTail(path, MaxLine);

    /// <summary>Reads what Claude Code wrote since the last call.</summary>
    public void Read()
    {
        lock (_lock)
        {
            _tail.Read(Line);
        }
    }

    /// <summary>The messages after the one numbered <paramref name="seen"/> (0 for all kept), and the last one's number.</summary>
    public (IReadOnlyList<ChatEntry> Entries, long Last) Since(long seen)
    {
        lock (_lock)
        {
            var from = (int)Math.Clamp(seen - _first + 1, 0, _entries.Count);
            return (_entries.GetRange(from, _entries.Count - from), _first + _entries.Count - 1);
        }
    }

    private bool Line(ReadOnlySpan<byte> line)
    {
        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || Flag(root, Fields.IsSidechain) || Flag(root, Fields.IsMeta) || Flag(root, Fields.IsCompactSummary)
                || !root.TryGetProperty(Fields.Message, out var message) || message.ValueKind != JsonValueKind.Object
                || !message.TryGetProperty(Fields.Content, out var content))
            {
                return false;
            }
            var type = Str(root, Fields.Type);
            var before = _entries.Count;
            if (type == Kinds.User)
            {
                User(content);
            }
            else if (type == Kinds.Assistant)
            {
                Assistant(content);
            }
            return _entries.Count != before;
        }
        catch (JsonException)
        {
            return false; // a line still being written, or not JSON
        }
    }

    /// <summary>What you typed; not the tools' results, nor what Claude Code adds in tags (commands, reminders).</summary>
    private void User(JsonElement content)
    {
        if (content.ValueKind == JsonValueKind.String)
        {
            Add(Roles.You, content.GetString());
            return;
        }
        if (content.ValueKind != JsonValueKind.Array)
        {
            return;
        }
        foreach (var block in content.EnumerateArray())
        {
            if (Str(block, Fields.Type) == Kinds.Text)
            {
                Add(Roles.You, Str(block, Fields.Text));
            }
        }
    }

    /// <summary>What Claude said, and a line per tool it ran ("Bash  git status").</summary>
    private void Assistant(JsonElement content)
    {
        if (content.ValueKind != JsonValueKind.Array)
        {
            return;
        }
        foreach (var block in content.EnumerateArray())
        {
            var kind = Str(block, Fields.Type);
            if (kind == Kinds.Text)
            {
                Add(Roles.Claude, Str(block, Fields.Text));
            }
            else if (kind == Kinds.ToolUse)
            {
                var detail = block.TryGetProperty(Fields.Input, out var input) && input.ValueKind == JsonValueKind.Object
                    ? ToolDetail.Select(name => Str(input, name)).FirstOrDefault(v => !string.IsNullOrWhiteSpace(v))
                    : null;
                var name = Str(block, Fields.Name) ?? Kinds.ToolUse;
                Add(Roles.Tool, detail is null ? name : $"{name}  {Cut(detail.ReplaceLineEndings(" "), MaxTool)}");
            }
        }
    }

    private void Add(string role, string? text)
    {
        text = text?.Trim();
        if (string.IsNullOrEmpty(text) || (role == Roles.You && text.StartsWith('<')))
        {
            return;
        }
        _entries.Add(new ChatEntry(role, Cut(text, MaxText)));
        if (_entries.Count > Keep)
        {
            _entries.RemoveAt(0);
            _first++;
        }
    }

    private static string Cut(string text, int max) => text.Length <= max ? text : text[..max] + "…";

    private static string? Str(JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool Flag(JsonElement e, string name) => e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;
}

/// <summary>
/// The Claude Code conversations the phones read (the chat view): which session each terminal runs, as the page last
/// said (js/phone.js), and each session's transcript, read as it grows.
/// </summary>
internal sealed class PhoneChat
{
    private const string TerminalsField = "terminals";
    private const string IdField = "id";
    private const string SessionField = "session";

    private readonly string _projects;
    private readonly Lock _lock = new();
    private Dictionary<string, string> _sessions = new();
    private readonly Dictionary<string, ChatTranscript> _transcripts = new();

    public PhoneChat() : this(ClaudeUsageTracker.ProjectsDirectory())
    {
    }

    /// <param name="projects">Claude Code's projects folder (tests use their own).</param>
    public PhoneChat(string projects) => _projects = projects;

    /// <summary>The page's picture of the terminals (js/phone.js): the Claude session each one runs.</summary>
    public void Learn(JsonElement state)
    {
        var sessions = new Dictionary<string, string>();
        if (state.ValueKind == JsonValueKind.Object && state.TryGetProperty(TerminalsField, out var terminals) && terminals.ValueKind == JsonValueKind.Array)
        {
            foreach (var t in terminals.EnumerateArray())
            {
                if (t.ValueKind == JsonValueKind.Object && t.TryGetProperty(IdField, out var id) && id.ValueKind == JsonValueKind.String
                    && t.TryGetProperty(SessionField, out var session) && session.ValueKind == JsonValueKind.String)
                {
                    sessions[id.GetString()!] = session.GetString()!;
                }
            }
        }
        lock (_lock)
        {
            _sessions = sessions;
        }
    }

    /// <summary>The conversation in a terminal, read up to now; null when it runs no Claude session with a transcript.</summary>
    public (string Session, ChatTranscript Transcript)? Of(string pane)
    {
        ChatTranscript? transcript;
        string? session;
        lock (_lock)
        {
            if (!_sessions.TryGetValue(pane, out session))
            {
                return null;
            }
            _transcripts.TryGetValue(session, out transcript);
        }
        if (transcript is null)
        {
            if (ClaudeUsageTracker.FindTranscript(_projects, session) is not { } path)
            {
                return null; // not written yet: Claude Code starts it with the first prompt
            }
            lock (_lock)
            {
                transcript = _transcripts.TryGetValue(session, out var known) ? known : _transcripts[session] = new ChatTranscript(path);
            }
        }
        transcript.Read();
        return (session, transcript);
    }

    /// <summary>A message for the phone: the entries as JSON.</summary>
    public static JsonArray ToJson(IEnumerable<ChatEntry> entries) =>
        new(entries.Select(e => (JsonNode)new JsonObject { ["role"] = e.Role, ["text"] = e.Text }).ToArray());
}
