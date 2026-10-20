namespace Termilly.Shared;

/// <summary>
/// Termilly's API over its pipe (Termilly.Agent/Api.cs is the client, Desktop's Features/PageApi.cs answers): one
/// request line { v, api, ...arguments }, one reply line { ok, result } or { ok: false, error }.
/// </summary>
internal static class ApiMethods
{
    public const string List = "list";
    public const string State = "state";
    public const string Status = "status";
    public const string Open = "open";
    public const string Send = "send";
    public const string Snippets = "snippets";
    public const string Snippet = "snippet";
    public const string Read = "read";
    public const string Wait = "wait";
    public const string History = "history";
    public const string Capabilities = "capabilities";
    /// <summary>Termilly started again while one runs (OpenFolder.cs): that window comes to the front.</summary>
    public const string Activate = "activate";

    /// <summary>The methods that type into a terminal: they need Settings › Terminal › API, and may wait on the user.</summary>
    public static readonly IReadOnlyList<string> Typing = [Send, Snippet];
}

/// <summary>The fields of the API's requests and replies.</summary>
internal static class ApiFields
{
    // Every request and reply.
    public const string Version = HookMessage.Fields.Version;
    public const string Method = "api";
    /// <summary>The terminal that asks, so Termilly can show who read or typed into another one.</summary>
    public const string From = "from";
    public const string Ok = "ok";
    public const string Result = "result";
    public const string Error = "error";

    // Arguments.
    public const string Pane = HookMessage.Fields.Pane;
    public const string Text = "text";
    public const string Enter = "enter";
    public const string Name = "name";
    public const string Vars = "vars";
    public const string Command = "command";
    public const string Argv = "argv";
    public const string Profile = "profile";
    public const string Cwd = HookMessage.Fields.Cwd;
    public const string Workspace = "workspace";
    public const string What = "what";
    public const string Count = "count";
    public const string Until = "until";
    public const string Pattern = "pattern";
    public const string TimeoutSeconds = "timeout_s";
    public const string Query = "query";
    public const string Failed = "failed";
    public const string In = "in";
    public const string Limit = "limit";
    /// <summary>"Open in Termilly": bring the window to the front, and reuse a terminal already in the folder.</summary>
    public const string Activate = ApiMethods.Activate;
    public const string Reuse = "reuse";

    // Results.
    public const string Id = "id";
    public const string Title = "title";
    public const string Agent = "agent";
    public const string Busy = "busy";
    public const string Queued = "queued";
    public const string AllowInput = "allowInput";
    public const string TimedOut = "timedOut";
    public const string ExitCode = "exitCode";
    public const string Matched = "matched";
    public const string Lines = "lines";
}

/// <summary>What a request leaves out gets these.</summary>
internal static class ApiDefaults
{
    /// <summary>How many commands history returns.</summary>
    public const int HistoryLimit = 30;
}

/// <summary>The values of read's "what" and wait's "until".</summary>
internal static class ApiReadModes
{
    public const string LastCommand = "last_command";
    public const string Lines = ApiFields.Lines;
    public const string CommandFinished = "command_finished";
    public const string OutputMatches = "output_matches";
}
