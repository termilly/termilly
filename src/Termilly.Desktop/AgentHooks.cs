using System.IO;
using Fields = Termilly.Shared.HookMessage.Fields;
using System.IO.Pipes;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// An agent event a terminal's hook reported (see Termilly.Agent/Protocol.cs). For PreToolUse and PostToolUse:
/// <see cref="File"/> is the file an edit tool changes, <see cref="Cwd"/> Claude's folder (edit and shell tools), and
/// <see cref="Dirs"/> the folders of the paths a shell command names.
/// </summary>
internal sealed record AgentEvent(string Pane, string Event, string? Session, string? Tool, string? Message, string? Reason,
    string? File = null, string? Cwd = null, IReadOnlyList<string>? Dirs = null, string? Target = null, Subagent? Subagent = null,
    StatusReport? Status = null);

/// <summary>What Termilly's status line reports (Termilly.Agent/StatusLine.cs): the plan's limits, the context, Claude's cost.</summary>
internal sealed record StatusReport(PlanLimits? Limits, ContextFigures? Context, ClaudeCost? Cost);

/// <summary>Claude's own figure for a session's cost (what /cost shows), and how long it has run.</summary>
internal sealed record ClaudeCost(double Usd, double? DurationMs);

/// <summary>
/// What an event says about a subagent: the one it comes from (AgentId, AgentType), or for an Agent call what it
/// starts (ToolUseId, Description, SubagentType, Background) and, once started, its id (LaunchedId).
/// </summary>
internal sealed record Subagent(string? AgentId, string? AgentType, string? ToolUseId = null, string? Description = null,
    string? SubagentType = null, bool Background = false, string? LaunchedId = null, string? Transcript = null);

/// <summary>One of the plan's usage windows: how much is used (percent) and when it resets (Unix seconds).</summary>
internal sealed record PlanWindow(double Used, long? ResetsAt);

/// <summary>The plan's usage limits from Claude Code's status line (Pro and Max): the 5-hour and weekly windows.</summary>
internal sealed record PlanLimits(PlanWindow? FiveHour, PlanWindow? SevenDay);

/// <summary>Claude Code's own context figures from its status line: percent used, window size, tokens in context.</summary>
internal sealed record ContextFigures(double Used, long Size, long? Tokens);

/// <summary>One text replacement of an Edit or MultiEdit.</summary>
internal sealed record EditReplace(string? Old, string? New, bool ReplaceAll);

/// <summary>
/// The edit itself, which the hook sends after PostToolUse only when the app asks for it (the change preview's
/// "full edit" mode). <see cref="Truncated"/> means a text was too long to pass on.
/// </summary>
internal sealed record EditContent(string Pane, string? Session, string? Tool, string File, string? Cwd,
    IReadOnlyList<EditReplace> Edits, string? Content, string? NewSource, string? Original, bool Truncated);

/// <summary>What the app answers a hook event.</summary>
internal enum HookReply
{
    /// <summary>Not one of this window's panes.</summary>
    Unknown,
    Ok,
    /// <summary>Known, and please send the edit itself (see <see cref="EditContent"/>).</summary>
    SendEdit,
}

/// <summary>
/// Knows what coding agents in Termilly's terminals are doing, from their own hooks rather than from guessing at
/// their output. Claude Code started in a terminal goes through the claude shim in agent\, which adds the hooks in
/// <see cref="ClaudeHookSettings.Write"/>; each hook runs termilly-hook.exe, which sends the event here over a named pipe
/// only this user can open.
/// </summary>
internal sealed class AgentHooks : IDisposable
{
    public const int Version = HookMessage.Version;
    private const int Kb = 1024;
    private const int MaxLine = 64 * Kb;
    /// <summary>How much of a message the reader starts with (it grows up to the message's limit).</summary>
    private const int FirstRead = 16 * Kb;
    /// <summary>
    /// The helper writes "event" right after the version and pane: once this much has arrived, the start says whether
    /// it's an edit, within the first <see cref="KindWindow"/> bytes.
    /// </summary>
    private const int KindCheckAt = 256;
    private const int KindWindow = 512;
    /// <summary>How long an edit message, which carries whole files, may take to arrive.</summary>
    private static readonly TimeSpan EditReadTime = TimeSpan.FromSeconds(5);
    /// <summary>How an edit message's start reads.</summary>
    private static readonly string EditMark = $"\"{Fields.Event}\":\"{HookEvents.Edit}\"";
    /// <summary>The helper's folder next to the app, and the hooks' settings' folder in the data folder.</summary>
    private const string AgentFolder = "agent";
    private const string ClaudeSettingsFile = "claude-settings.json";
    /// <summary>The longest event name a remote hook may report.</summary>
    private const int MaxRemoteEvent = 40;
    /// <summary>Percentages (context, plan limits) are kept within this.</summary>
    private const double MaxPercent = 100;
    /// <summary>How long to wait before listening again when every pipe instance is busy.</summary>
    private static readonly TimeSpan ListenRetry = TimeSpan.FromSeconds(1);
    /// <summary>What a remote hook's message loses: files, folders, limits and cost only mean something on this PC.</summary>
    private static readonly string[] LocalOnly = [Fields.File, Fields.Cwd, Fields.Dirs, Fields.Limits, Fields.Context, Fields.Cost, Fields.Transcript];
    /// <summary>An edit message carries whole files, up to the helper's 8M-character limit per text.</summary>
    private const int MaxEditLine = 40 * Kb * Kb;

    /// <summary>The helper and the claude shim, copied next to the app at build time.</summary>
    public static string AgentDirectory { get; } = Path.Combine(AppContext.BaseDirectory, AgentFolder);

    public static string HookExe => Path.Combine(AgentDirectory, AppPaths.Exe(AgentExecutables.Hook));

    /// <summary>Hooks Termilly adds to Claude Code, regenerated at every start (the app's folder may have moved).</summary>
    public static string ClaudeSettingsPath => Path.Combine(AppPaths.DataDirectory, AgentFolder, ClaudeSettingsFile);

    /// <summary>
    /// What an event means for the pane: working, needs-input, done, error, exited, or idle (an agent is there,
    /// waiting for a prompt). Null for events that don't change anything.
    /// </summary>
    /// <remarks>
    /// PermissionRequest, not Notification's permission_prompt, means "needs you": the notification waits about six
    /// seconds and restarts on every keystroke. AskUserQuestion is Claude asking the user something, so it needs
    /// them too, though no permission is involved.
    /// </remarks>
    public static string? StateFor(AgentEvent e) => e.Event switch
    {
        // A subagent starting or stopping never makes the terminal look busy, done or idle.
        HookEvents.SubagentStart or HookEvents.SubagentStop => null,
        HookEvents.SessionStart => AgentStates.Idle,
        HookEvents.PreToolUse when e.Tool == ClaudeTools.AskUserQuestion => AgentStates.NeedsInput,
        HookEvents.UserPromptSubmit or HookEvents.PreToolUse or HookEvents.PostToolUse or HookEvents.PreCompact => AgentStates.Working,
        HookEvents.PermissionRequest => AgentStates.NeedsInput,
        HookEvents.Stop => AgentStates.Done,
        HookEvents.StopFailure => AgentStates.Error,
        HookEvents.SessionEnd => AgentStates.Exited,
        _ => null,
    };

    /// <summary>The longest remote hook report taken (base64); the remote hook keeps its own well under this.</summary>
    private const int MaxRemoteReport = 16 * Kb;

    /// <summary>
    /// An event a remote host's hook reported through the terminal (shell/remote/termilly-hook.sh: the event and its
    /// message in base64); null for anything else. Whatever runs in a terminal can print this, so it only ever speaks
    /// for its own terminal: the pane is <paramref name="pane"/>, and it carries no file, folders, limits or cost,
    /// which only mean something on this PC.
    /// </summary>
    public static AgentEvent? ParseRemote(string pane, string? hookEvent, string? base64)
    {
        if (string.IsNullOrEmpty(hookEvent) || hookEvent.Length > MaxRemoteEvent || !hookEvent.All(char.IsAsciiLetter) ||
            base64 is null || base64.Length > MaxRemoteReport)
        {
            return null;
        }
        JsonObject message;
        try
        {
            message = base64.Length > 0 && JsonNode.Parse(Convert.FromBase64String(base64)) is JsonObject sent ? sent : new JsonObject();
        }
        catch (Exception e) when (e is FormatException or JsonException)
        {
            message = new JsonObject(); // an unreadable message still reports the event
        }
        foreach (var local in LocalOnly)
        {
            message.Remove(local);
        }
        message[Fields.Version] = Version;
        message[Fields.Pane] = pane;
        message[Fields.Event] = hookEvent;
        return Parse(message.ToJsonString());
    }

    /// <summary>An API request: { v: 1, api: "method", ...arguments }; null for anything else.</summary>
    public static JsonObject? ApiRequest(string? line)
    {
        try
        {
            return !string.IsNullOrWhiteSpace(line) && JsonNode.Parse(line) is JsonObject message &&
                   IsThisVersion(message) && Text(message, ApiFields.Method) is not null
                ? message
                : null;
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Reads one hook message; null when it isn't one (wrong version, missing fields, not JSON).</summary>
    public static AgentEvent? Parse(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }
        try
        {
            if (JsonNode.Parse(line) is not JsonObject message || !IsThisVersion(message) ||
                Text(message, Fields.Pane) is not { } pane || Text(message, Fields.Event) is not { } hookEvent)
            {
                return null;
            }
            return new AgentEvent(pane, hookEvent, Text(message, Fields.Session), Text(message, Fields.Tool), Text(message, Fields.Message),
                Text(message, Fields.Reason), Text(message, Fields.File), Text(message, Fields.Cwd), Folders(message),
                Text(message, Fields.Target), SubagentOf(message), StatusOf(message));
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>Reads an edit message ({ event: "Edit", file, edit: {...} }); null for anything else.</summary>
    public static EditContent? ParseEdit(string? line)
    {
        if (string.IsNullOrWhiteSpace(line))
        {
            return null;
        }
        try
        {
            if (JsonNode.Parse(line) is not JsonObject message || !IsThisVersion(message) ||
                Text(message, Fields.Event) != HookEvents.Edit || Text(message, Fields.Pane) is not { } pane ||
                Text(message, Fields.File) is not { } file || message[Fields.Edit] is not JsonObject edit)
            {
                return null;
            }
            var edits = new List<EditReplace>();
            foreach (var item in edit[Fields.Edits] as JsonArray ?? [])
            {
                if (item is JsonObject change)
                {
                    edits.Add(new EditReplace(Raw(change, Fields.Old), Raw(change, Fields.New), Flag(change, Fields.ReplaceAll)));
                }
            }
            return new EditContent(pane, Text(message, Fields.Session), Text(message, Fields.Tool), file, Text(message, Fields.Cwd),
                edits, Raw(edit, Fields.Content), Raw(edit, Fields.NewSource), Raw(edit, Fields.Original), Flag(edit, Fields.Truncated));
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>The context figures a status line message carries; null for other messages and older Claude Code.</summary>
    private static ContextFigures? Context(JsonObject message)
    {
        static double? Num(JsonNode? n) => n is JsonValue v && v.TryGetValue<double>(out var d) && double.IsFinite(d) ? d : null;
        return message[Fields.Context] is JsonObject c && Num(c[Fields.Used]) is { } used && Num(c[Fields.Size]) is { } size && size > 0
            ? new ContextFigures(Math.Clamp(used, 0, MaxPercent), (long)size, Num(c[Fields.Tokens]) is { } t ? (long)t : null)
            : null;
    }

    /// <summary>The plan limits a status line message carries; null for other messages.</summary>
    private static PlanLimits? Limits(JsonObject message)
    {
        if (message[Fields.Limits] is not JsonObject limits)
        {
            return null;
        }
        static PlanWindow? Window(JsonNode? node) =>
            node is JsonObject w && w[Fields.Used] is JsonValue u && u.TryGetValue<double>(out var used) && double.IsFinite(used)
                ? new PlanWindow(Math.Clamp(used, 0, MaxPercent), w[Fields.ResetsAt] is JsonValue r && r.TryGetValue<double>(out var at) && double.IsFinite(at) ? (long)at : null)
                : null;
        return new PlanLimits(Window(limits[Fields.FiveHour]), Window(limits[Fields.SevenDay]));
    }

    /// <summary>The folders a shell command names ("dirs"), at most ten; null when there are none.</summary>
    private static List<string>? Folders(JsonObject message)
    {
        var folders = (message[Fields.Dirs] as JsonArray ?? [])
            .Select(d => d is JsonValue v && v.TryGetValue<string>(out var text) && text.Length is > 0 and <= HookMessage.MaxPath ? text : null)
            .OfType<string>().Take(HookMessage.MaxFolders).ToList();
        return folders.Count > 0 ? folders : null;
    }

    // Unlike Text, an empty string is kept: an edit can replace text with nothing.
    private static string? Raw(JsonObject message, string name) =>
        message[name] is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;

    private static string? Text(JsonObject message, string name) =>
        message[name] is JsonValue value && value.TryGetValue<string>(out var text) && text.Length > 0 ? text : null;

    private static bool Flag(JsonObject message, string name) =>
        message[name] is JsonValue value && value.TryGetValue<bool>(out var flag) && flag;

    /// <summary>A message for this version of the hook (an older helper left running speaks another).</summary>
    private static bool IsThisVersion(JsonObject message) =>
        message[Fields.Version]?.GetValueKind() == JsonValueKind.Number && message[Fields.Version]!.GetValue<int>() == Version;

    /// <summary>A figure from a status line message's cost (Claude's own: dollars, duration), or null.</summary>
    /// <summary>A status line's report; null for other messages.</summary>
    private static StatusReport? StatusOf(JsonObject message)
    {
        var limits = Limits(message);
        var context = Context(message);
        var cost = CostOf(message, Fields.Usd) is { } usd ? new ClaudeCost(usd, CostOf(message, Fields.DurationMs)) : null;
        return limits is null && context is null && cost is null ? null : new StatusReport(limits, context, cost);
    }

    private static double? CostOf(JsonObject message, string name) =>
        message[Fields.Cost] is JsonObject cost && cost[name] is JsonValue v && v.TryGetValue<double>(out var n) && double.IsFinite(n) ? n : null;

    /// <summary>The subagent fields of a message (see Protocol.Message), or null when it has none.</summary>
    private static Subagent? SubagentOf(JsonObject message)
    {
        var agentId = Text(message, Fields.AgentId);
        var toolUseId = Text(message, Fields.ToolUseId);
        if (agentId is null && toolUseId is null)
        {
            return null;
        }
        return new Subagent(agentId, Text(message, Fields.AgentType), toolUseId, Text(message, Fields.Description),
            Text(message, Fields.SubagentType), Flag(message, Fields.Background), Text(message, Fields.LaunchedId), Text(message, Fields.Transcript));
    }

    private readonly Func<AgentEvent, HookReply> _received;
    private readonly Func<JsonObject, Task<JsonObject>>? _api;
    private readonly Action<EditContent>? _edit;
    private readonly CancellationTokenSource _stop = new();

    /// <param name="received">Called on a pool thread for every event, before the hook gets its answer.</param>
    /// <param name="api">Answers API requests ({ api: method, ... }) from the termilly command and MCP server.</param>
    /// <param name="edit">Gets the edits that <paramref name="received"/> asked for with <see cref="HookReply.SendEdit"/>.</param>
    public AgentHooks(Func<AgentEvent, HookReply> received, string? pipeName = null,
        Func<JsonObject, Task<JsonObject>>? api = null, Action<EditContent>? edit = null)
    {
        _received = received;
        _api = api;
        _edit = edit;
        PipeName = pipeName ?? PipeNames.ForProcess(Environment.ProcessId);
        _ = Task.Run(AcceptAsync);
    }

    /// <param name="received">Called on a pool thread for every event; returns whether the pane is one of this window's.</param>
    public AgentHooks(Func<AgentEvent, bool> received, string? pipeName = null, Func<JsonObject, Task<JsonObject>>? api = null)
        : this(e => received(e) ? HookReply.Ok : HookReply.Unknown, pipeName, api)
    {
    }

    /// <summary>One pipe per Termilly window, so a second instance (or a test run) gets its own events.</summary>
    public string PipeName { get; }

    private async Task AcceptAsync()
    {
        while (!_stop.IsCancellationRequested)
        {
            NamedPipeServerStream server;
            try
            {
                server = new NamedPipeServerStream(
                    PipeName, PipeDirection.InOut, NamedPipeServerStream.MaxAllowedServerInstances,
                    PipeTransmissionMode.Byte, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            }
            catch (IOException)
            {
                await Task.Delay(ListenRetry).ConfigureAwait(false); // all instances busy, or the name was taken: try again
                continue;
            }

            try
            {
                await server.WaitForConnectionAsync(_stop.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is OperationCanceledException or IOException)
            {
                await server.DisposeAsync().ConfigureAwait(false);
                continue;
            }
            _ = Task.Run(() => HandleAsync(server));
        }
    }

    private async Task HandleAsync(NamedPipeServerStream server)
    {
        await using (server.ConfigureAwait(false))
        {
            try
            {
                using var cancel = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
                cancel.CancelAfter(PipeTimeouts.Read);
                var line = await ReadLineAsync(server, cancel).ConfigureAwait(false);
                string reply;
                if (ApiRequest(line) is { } request && _api is not null)
                {
                    // The page may need a moment; typing (send, snippet) may wait for the user to say yes on production.
                    cancel.CancelAfter(PipeTimeouts.ForApi(request[ApiFields.Method]?.ToString()));
                    reply = (await _api(request).ConfigureAwait(false)).ToJsonString();
                }
                else if (ParseEdit(line) is { } edit)
                {
                    _edit?.Invoke(edit);
                    reply = HookReplies.Ok;
                }
                else
                {
                    reply = (Parse(line) is { } e ? _received(e) : HookReply.Unknown) switch
                    {
                        HookReply.Ok => HookReplies.Ok,
                        HookReply.SendEdit => HookReplies.SendEdit,
                        _ => HookReplies.Unknown,
                    };
                }
                await server.WriteAsync(Encoding.UTF8.GetBytes(reply + "\n"), cancel.Token).ConfigureAwait(false);
                await server.FlushAsync(cancel.Token).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or OperationCanceledException or ObjectDisposedException)
            {
                // The hook gave up or the window is closing; the next event will tell.
            }
        }
    }

    /// <summary>
    /// Reads up to the first newline. Anything longer than 64 KB is not one of ours, except an edit message, which
    /// carries whole files and gets up to 40 MB and more time.
    /// </summary>
    private static async Task<string?> ReadLineAsync(Stream stream, CancellationTokenSource cancel)
    {
        var buffer = new byte[FirstRead];
        var length = 0;
        var max = MaxLine;
        var checkedKind = false;
        while (true)
        {
            if (length == buffer.Length)
            {
                if (length >= max)
                {
                    return null;
                }
                Array.Resize(ref buffer, Math.Min(buffer.Length * 2, max));
            }
            var read = await stream.ReadAsync(buffer.AsMemory(length), cancel.Token).ConfigureAwait(false);
            if (read == 0)
            {
                return length < max ? Encoding.UTF8.GetString(buffer, 0, length) : null;
            }
            var newline = Array.IndexOf(buffer, (byte)'\n', length, read);
            length += read;
            if (newline >= 0)
            {
                return Encoding.UTF8.GetString(buffer, 0, newline);
            }
            // The helper writes "event" right after the version and pane, so it is always near the start.
            if (!checkedKind && length >= KindCheckAt)
            {
                checkedKind = true;
                if (Encoding.UTF8.GetString(buffer, 0, Math.Min(length, KindWindow)).Contains(EditMark, StringComparison.Ordinal))
                {
                    max = MaxEditLine;
                    cancel.CancelAfter(EditReadTime);
                }
            }
        }
    }

    // The token source isn't disposed: the accept loop may still be reading its token as it winds down.
    public void Dispose() => _stop.Cancel();
}
