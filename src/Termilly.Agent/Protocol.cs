using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Agent;

/// <summary>
/// How a terminal's helper reaches the Termilly window that started it. The app sets these variables in every
/// terminal (see SessionProfiles.AgentEnvironment, which must use the same names).
/// </summary>
internal static partial class Protocol
{
    /// <summary>The terminal's id in Termilly: which pane an event belongs to.</summary>
    public const string PaneVariable = TerminalEnvironment.PaneId;
    /// <summary>The named pipe of the Termilly window that owns the terminal.</summary>
    public const string PipeVariable = TerminalEnvironment.Pipe;
    /// <summary>Claude Code settings file holding Termilly's hooks; the shim passes it with --settings.</summary>
    public const string SettingsVariable = TerminalEnvironment.AgentSettings;
    /// <summary>Set by the shim for the Claude Code it starts, so a claude started from inside it isn't hooked twice.</summary>
    public const string ShimVariable = TerminalEnvironment.AgentShim;

    /// <summary>Version of the hook command line and message; bump when either changes.</summary>
    public const int Version = HookMessage.Version;

    /// <summary>The longest id passed on (a session's, a tool's, a subagent's), and the longest short text.</summary>
    private const int MaxId = 100;
    /// <summary>The longest error passed on for a failed turn.</summary>
    private const int MaxError = 200;
    /// <summary>How much of a shell command is looked at for the program it runs, and how much of that is kept.</summary>
    private const int MaxCommandLook = 2000;
    private const int MaxProgram = 40;
    /// <summary>The most of a search pattern shown, and of a subagent's type.</summary>
    private const int MaxPattern = 40;
    private const int MaxSubagentType = 60;
    /// <summary>The longest notebook cell id, and edit mode, passed on.</summary>
    private const int MaxCellId = 200;
    private const int MaxEditMode = 20;
    /// <summary>The folder ChangeDirectory captures.</summary>
    private const string DirGroup = "dir";
    /// <summary>A path ending in these is a folder, though it has a dot.</summary>
    private static readonly string[] DotFolders = [".", ".."];
    /// <summary>What a cut text ends with.</summary>
    private const string Ellipsis = "…";

    /// <summary>The fields of Claude Code's hook payload that are read.</summary>
    private static class Payload
    {
        public const string SessionId = "session_id";
        public const string ToolName = "tool_name";
        public const string ToolInput = "tool_input";
        public const string ToolResponse = "tool_response";
        public const string ToolUseId = "tool_use_id";
        public const string Message = "message";
        public const string LastAssistantMessage = "last_assistant_message";
        public const string Reason = "reason";
        public const string Error = "error";
        public const string AgentId = "agent_id";
        public const string AgentType = "agent_type";
        public const string AgentTranscriptPath = "agent_transcript_path";
        public const string Cwd = "cwd";
        public const string OriginalFile = "originalFile";
        /// <summary>The id an Agent call's response gives the subagent it started.</summary>
        public const string LaunchedAgentId = "agentId";
    }

    /// <summary>The fields of a tool's input that are read.</summary>
    private static class Input
    {
        public const string Command = "command";
        public const string FilePath = "file_path";
        public const string NotebookPath = "notebook_path";
        public const string Pattern = "pattern";
        public const string Description = "description";
        public const string SubagentType = "subagent_type";
        public const string RunInBackground = "run_in_background";
        public const string Edits = "edits";
        public const string OldString = "old_string";
        public const string NewString = "new_string";
        public const string ReplaceAll = "replace_all";
        public const string Content = "content";
        public const string CellId = "cell_id";
        public const string NewSource = "new_source";
        public const string EditMode = "edit_mode";
    }

    /// <summary>The longest agent message passed on (the inbox shows a line or two of it).</summary>
    public const int MaxMessage = 500;

    /// <summary>The longest file path passed on for an edit tool.</summary>
    public const int MaxPath = HookMessage.MaxPath;

    /// <summary>The longest single text in an edit message (old or new text, a written file).</summary>
    public const int MaxEditChars = 8 << 20;

    // Claude's shell tools (ClaudeTools.ShellTools): a command can create or change files too (Copy-Item, Set-Content,
    // sed -i), so while one runs the change preview watches the folders it may touch: the folder Claude works in, and
    // the folders of the paths the command names (see CommandFolders). The command itself is never passed.

    /// <summary>The most folders passed for one command.</summary>
    public const int MaxFolders = HookMessage.MaxFolders;

    /// <summary>
    /// The folders of the paths a command names, worked out here so that only they leave the hook: for
    /// "Set-Content 'd:\temp\b.ps1'" that's "d:\temp". A path that looks like a file (it has an extension) gives its
    /// folder; one that doesn't is taken as a folder. Relative paths are taken from where the command first changes
    /// to (cd /d/temp && sed -i ... test.ps1 gives "/d/temp"), else stay relative (the app reads them from Claude's
    /// folder); a bare file name gives that folder, or ".".
    /// </summary>
    public static List<string> CommandFolders(string? command)
    {
        var folders = new List<string>();
        if (string.IsNullOrEmpty(command))
        {
            return folders;
        }
        var cd = ChangeDirectory().Match(command) is { Success: true } go ? go.Groups[DirGroup].Value : null;
        foreach (System.Text.RegularExpressions.Match m in CommandPath().Matches(command))
        {
            var path = m.Value.TrimEnd('.', ',', ';', ':');
            var cut = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
            var last = path[(cut + 1)..];
            var folder = !last.Contains('.') || DotFolders.Contains(last) ? path
                : cut > 0 ? path[..cut]
                : cut == 0 ? path[..1]
                : ".";
            if (cd is not null && !IsRooted(folder))
            {
                folder = folder == "." ? cd : cd.TrimEnd('/', '\\') + "/" + folder;
            }
            if (folder.Length is > 0 and <= MaxPath && !folders.Contains(folder, StringComparer.OrdinalIgnoreCase))
            {
                folders.Add(folder);
            }
            if (folders.Count == MaxFolders)
            {
                break;
            }
        }
        return folders;
    }

    private static bool IsRooted(string path) =>
        path.Length >= 2 && path[1] == ':' || path.StartsWith('/') || path.StartsWith('\\') || path.StartsWith('~');

    // Windows paths (C:\a\b.ps1, C:/a), Git Bash drives (/c/a/b.ps1, /d/temp), Linux paths (/tmp/proj/a.ts,
    // /home/me/proj; at least two characters after the slash, so cmd's /c isn't a drive), home (~/a), relative paths
    // with a folder (src/a.ts, .\a.ps1) and bare file names with an extension (a.ps1). Quotes, separators and shell
    // variables ($i) end a path.
    [System.Text.RegularExpressions.GeneratedRegex(@"(?<![\w$-])(?:[A-Za-z]:[\\/]|/[a-zA-Z]/|~[\\/]|\.{1,2}[\\/]|/(?=[\w.@-]{2}))?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,10}(?![\w(])|(?<![\w$-])(?:[A-Za-z]:[\\/]|/[a-zA-Z]/|~[\\/]|/(?=[\w.@-]{2}))(?:[\w.@-]+[\\/])*[\w.@-]*")]
    private static partial System.Text.RegularExpressions.Regex CommandPath();

    // Where a command first moves to: cd, pushd, Set-Location, Push-Location, sl (with -Path or -LiteralPath).
    [System.Text.RegularExpressions.GeneratedRegex(@"(?:^|[;&|(]\s*)(?:cd|pushd|Set-Location|Push-Location|sl)\s+(?:-(?:Literal)?Path\s+)?(['""]?)(?<dir>[^'""\s;&|)]+)\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase)]
    private static partial System.Text.RegularExpressions.Regex ChangeDirectory();

    /// <summary>
    /// The one-line message for an agent event: the pane, the event and the few payload fields Termilly shows.
    /// Prompts, transcripts and tool input are never passed on, apart from the path of the file an edit tool
    /// changes, and the folder Claude works in for edit and shell tools, which the change preview needs.
    /// </summary>
    public static string Message(string paneId, string hookEvent, string? payloadJson)
    {
        // An unreadable payload still reports the event.
        var payload = Parse(payloadJson);
        var tool = Text(payload, Payload.ToolName, MaxId);
        var message = new JsonObject
        {
            [HookMessage.Fields.Version] = Version,
            [HookMessage.Fields.Pane] = paneId,
            [HookMessage.Fields.Event] = hookEvent,
            [HookMessage.Fields.Session] = Text(payload, Payload.SessionId, MaxId),
            [HookMessage.Fields.Tool] = tool,
            // Notification carries "message"; Stop carries the reply that ended the turn.
            [HookMessage.Fields.Message] = Text(payload, Payload.Message, MaxMessage) ?? Text(payload, Payload.LastAssistantMessage, MaxMessage),
            [HookMessage.Fields.Reason] = Text(payload, Payload.Reason, MaxId) ?? Text(payload, Payload.Error, MaxError),
        };
        // Subagents (shown under their terminal): which one an event comes from, and for an Agent call what it starts.
        // Its prompt never leaves the hook: only its short description, type, whether it runs in the background,
        // and (after the call) the id it got.
        if (Text(payload, Payload.AgentId, MaxId) is { } agentId)
        {
            message[HookMessage.Fields.AgentId] = agentId;
            message[HookMessage.Fields.AgentType] = Text(payload, Payload.AgentType, MaxId);
            // When it stops, where its transcript is (a path, never its content): Termilly reads its token use for its cost.
            if (hookEvent == HookEvents.SubagentStop)
            {
                message[HookMessage.Fields.Transcript] = Text(payload, Payload.AgentTranscriptPath, MaxPath, cut: false);
            }
        }
        var toolEvent = hookEvent is HookEvents.PreToolUse or HookEvents.PostToolUse;
        if (toolEvent && tool is ClaudeTools.Agent or ClaudeTools.Task)
        {
            AddAgentCall(message, payload);
        }
        if (hookEvent == HookEvents.PreToolUse && ActivityTarget(payload) is { } target)
        {
            message[HookMessage.Fields.Target] = target;
        }
        if (toolEvent)
        {
            AddFiles(message, payload, tool);
        }
        // Where `claude --resume` has to run again after a restart: the shell may have moved on (`cd x && claude`).
        if (hookEvent == HookEvents.SessionStart)
        {
            message[HookMessage.Fields.Folder] = Text(payload, Payload.Cwd, MaxPath, cut: false);
        }
        return message.ToJsonString();
    }

    /// <summary>An Agent call: what it starts (never its prompt), whether in the background, and the id it got.</summary>
    private static void AddAgentCall(JsonObject message, JsonObject? payload)
    {
        var input = payload?[Payload.ToolInput] as JsonObject;
        message[HookMessage.Fields.ToolUseId] = Text(payload, Payload.ToolUseId, MaxId);
        message[HookMessage.Fields.Description] = Text(input, Input.Description, MaxId);
        message[HookMessage.Fields.SubagentType] = Text(input, Input.SubagentType, MaxId);
        message[HookMessage.Fields.Background] = input?[Input.RunInBackground] is JsonValue bg && bg.TryGetValue<bool>(out var background) && background;
        message[HookMessage.Fields.LaunchedId] = Text(payload?[Payload.ToolResponse] as JsonObject, Payload.LaunchedAgentId, MaxId);
    }

    /// <summary>For the change preview: the file an edit tool changes, or the folders a shell command may change.</summary>
    private static void AddFiles(JsonObject message, JsonObject? payload, string? tool)
    {
        if (EditFile(payload) is { } file)
        {
            message[HookMessage.Fields.File] = file;
            message[HookMessage.Fields.Cwd] = Text(payload, Payload.Cwd, MaxPath, cut: false);
        }
        else if (tool is not null && ClaudeTools.ShellTools.Contains(tool))
        {
            message[HookMessage.Fields.Cwd] = Text(payload, Payload.Cwd, MaxPath, cut: false);
            var folders = CommandFolders(Text(payload?[Payload.ToolInput] as JsonObject, Input.Command, int.MaxValue));
            if (folders.Count > 0)
            {
                message[HookMessage.Fields.Dirs] = new JsonArray(folders.Select(f => (JsonNode?)f).ToArray());
            }
        }
    }

    /// <summary>
    /// A few words for the activity line in Termilly's sidebar, never the input itself: the program a shell command
    /// runs (its first word only), the file a tool reads, a search's pattern (cut short), a subagent's type.
    /// </summary>
    public static string? ActivityTarget(JsonObject? payload)
    {
        var input = payload?[Payload.ToolInput] as JsonObject;
        return Text(payload, Payload.ToolName, MaxId) switch
        {
            ClaudeTools.Bash or ClaudeTools.PowerShell => Text(input, Input.Command, MaxCommandLook)?.TrimStart().Split((char[])[' ', '\t', '\n', '\r', ';', '|', '&'], 2)[0] is { Length: > 0 } program
                ? program.Length > MaxProgram ? program[..MaxProgram] : program : null,
            ClaudeTools.Read or ClaudeTools.NotebookRead => Text(input, Input.FilePath, MaxPath, cut: false) ?? Text(input, Input.NotebookPath, MaxPath, cut: false),
            ClaudeTools.Grep or ClaudeTools.Glob => Text(input, Input.Pattern, MaxPattern),
            ClaudeTools.Agent or ClaudeTools.Task => Text(input, Input.SubagentType, MaxSubagentType),
            _ => null,
        };
    }

    /// <summary>
    /// The edit itself, sent only when the app asks for it after PostToolUse (its "full edit" mode): the old and new
    /// texts of an Edit or MultiEdit, a Write's content, a notebook cell's new source, and the file as it was before,
    /// when Claude Code reports it. A text longer than <paramref name="maxChars"/> marks the edit as truncated, and
    /// the app then falls back to the file on disk.
    /// </summary>
    public static string EditMessage(string paneId, string? payloadJson, int maxChars = MaxEditChars)
    {
        var payload = Parse(payloadJson);
        var texts = new EditTexts(maxChars);
        var edit = EditBody(payload, texts);
        edit[HookMessage.Fields.Original] = texts.Full(payload?[Payload.ToolResponse] as JsonObject, Payload.OriginalFile);
        edit[HookMessage.Fields.Truncated] = texts.Truncated;
        return new JsonObject
        {
            [HookMessage.Fields.Version] = Version,
            [HookMessage.Fields.Pane] = paneId,
            [HookMessage.Fields.Event] = HookEvents.Edit,
            [HookMessage.Fields.Session] = Text(payload, Payload.SessionId, MaxId),
            [HookMessage.Fields.Tool] = Text(payload, Payload.ToolName, MaxId),
            [HookMessage.Fields.File] = EditFile(payload),
            [HookMessage.Fields.Cwd] = Text(payload, Payload.Cwd, MaxPath),
            [HookMessage.Fields.Edit] = edit,
        }.ToJsonString();
    }

    /// <summary>What an edit tool changed, by tool: its replacements, a file's new content, or a notebook cell's.</summary>
    private static JsonObject EditBody(JsonObject? payload, EditTexts texts)
    {
        var input = payload?[Payload.ToolInput] as JsonObject;
        var edit = new JsonObject();
        switch (Text(payload, Payload.ToolName, MaxId))
        {
            case ClaudeTools.Edit:
                edit[HookMessage.Fields.Edits] = new JsonArray(texts.Change(input));
                break;
            case ClaudeTools.MultiEdit:
                var edits = new JsonArray();
                foreach (var item in input?[Input.Edits] as JsonArray ?? [])
                {
                    edits.Add(texts.Change(item as JsonObject));
                }
                edit[HookMessage.Fields.Edits] = edits;
                break;
            case ClaudeTools.Write:
                edit[HookMessage.Fields.Content] = texts.Full(input, Input.Content);
                break;
            case ClaudeTools.NotebookEdit:
                edit[HookMessage.Fields.CellId] = Text(input, Input.CellId, MaxCellId);
                edit[HookMessage.Fields.NewSource] = texts.Full(input, Input.NewSource);
                edit[HookMessage.Fields.EditMode] = Text(input, Input.EditMode, MaxEditMode);
                break;
        }
        return edit;
    }

    /// <summary>An edit's texts, whole or not at all: one longer than the limit is left out, and the edit is truncated.</summary>
    private sealed class EditTexts(int maxChars)
    {
        public bool Truncated { get; private set; }

        public string? Full(JsonObject? from, string name)
        {
            if (from?[name] is not JsonValue value || !value.TryGetValue<string>(out var text))
            {
                return null;
            }
            if (text.Length <= maxChars)
            {
                return text;
            }
            Truncated = true;
            return null;
        }

        /// <summary>One replacement of an Edit or MultiEdit: the old text, the new, and whether every match changes.</summary>
        public JsonObject Change(JsonObject? item) => new()
        {
            [HookMessage.Fields.Old] = Full(item, Input.OldString),
            [HookMessage.Fields.New] = Full(item, Input.NewString),
            [HookMessage.Fields.ReplaceAll] = item?[Input.ReplaceAll] is JsonValue value && value.TryGetValue<bool>(out var all) && all,
        };
    }

    /// <summary>The file an edit tool changes, or null for any other tool.</summary>
    private static string? EditFile(JsonObject? payload)
    {
        if (Text(payload, Payload.ToolName, MaxId) is not { } tool || !ClaudeTools.EditTools.Contains(tool))
        {
            return null;
        }
        var input = payload?[Payload.ToolInput] as JsonObject;
        return Text(input, Input.FilePath, MaxPath, cut: false) ?? Text(input, Input.NotebookPath, MaxPath, cut: false);
    }

    private static JsonObject? Parse(string? json)
    {
        try
        {
            return string.IsNullOrWhiteSpace(json) ? null : JsonNode.Parse(json) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    // A cut path would point at a different file, so paths are dropped rather than cut.
    private static string? Text(JsonObject? payload, string name, int max, bool cut = true) =>
        payload?[name] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length > 0
            ? (text.Length <= max ? text : cut ? text[..max] + Ellipsis : null)
            : null;

    /// <summary>
    /// Sends one message to the app and returns its one-line reply, or null when the app isn't there (closed, or
    /// too slow: an agent must never wait on Termilly).
    /// </summary>
    public static string? Send(string pipeName, string message, TimeSpan timeout)
    {
        try
        {
            using var cancel = new CancellationTokenSource(timeout);
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            pipe.ConnectAsync(cancel.Token).GetAwaiter().GetResult();
            var bytes = Encoding.UTF8.GetBytes(message + "\n");
            pipe.WriteAsync(bytes, cancel.Token).AsTask().GetAwaiter().GetResult();
            pipe.FlushAsync(cancel.Token).GetAwaiter().GetResult();
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            return reader.ReadLineAsync(cancel.Token).AsTask().GetAwaiter().GetResult();
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or TimeoutException or UnauthorizedAccessException)
        {
            return null;
        }
    }
}
