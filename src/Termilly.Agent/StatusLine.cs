using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Agent;

/// <summary>
/// Claude Code's status line, as Termilly sets it (termilly-hook.exe statusline 1). Claude Code passes the status
/// line a JSON description of the session, including the plan's usage limits (rate_limits: the 5-hour and weekly
/// windows, for Pro and Max). This passes those limits to Termilly, then runs the user's own status line, if they
/// have one, with the same input, and prints what it prints: the status line looks as it did without Termilly.
/// </summary>
internal static class StatusLine
{
    /// <summary>How long the user's status line may take; Claude Code waits for it too.</summary>
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(5);
    /// <summary>How long telling Termilly may take, and how long the status line waits for it at the end.</summary>
    private static readonly TimeSpan TellTimeout = TimeSpan.FromMilliseconds(500);
    private static readonly TimeSpan TellWait = TimeSpan.FromSeconds(1);
    /// <summary>The longest session id passed on.</summary>
    private const int MaxSession = 100;
    private const double MaxPercent = 100;

    /// <summary>The user's status line in Claude Code's settings.</summary>
    private static class Settings
    {
        public const string StatusLine = "statusLine";
        public const string Command = "command";
    }

    /// <summary>What runs a status line command: Git Bash on Windows (where Git for Windows puts it), else cmd; sh elsewhere.</summary>
    private static class Shells
    {
        public const string UnixShell = "/bin/sh";
        public const string Cmd = "cmd.exe";
        public const string ParentFolder = "..";
    }

    /// <summary>The fields of Claude Code's status line input that are read.</summary>
    private static class Input
    {
        public const string RateLimits = "rate_limits";
        public const string FiveHour = "five_hour";
        public const string SevenDay = "seven_day";
        public const string UsedPercentage = "used_percentage";
        public const string ResetsAt = "resets_at";
        public const string SessionId = "session_id";
        public const string ContextWindow = "context_window";
        public const string ContextWindowSize = "context_window_size";
        public const string TotalInputTokens = "total_input_tokens";
        public const string Cost = "cost";
        public const string TotalCostUsd = "total_cost_usd";
        public const string TotalDurationMs = "total_duration_ms";
        public const string Workspace = "workspace";
        public const string ProjectDir = "project_dir";
        public const string CurrentDir = "current_dir";
        public const string Cwd = "cwd";
    }

    public static int Run(string version, Stream stdin, TextWriter stdout)
    {
        string payload;
        using (var reader = new StreamReader(stdin, Encoding.UTF8))
        {
            payload = reader.ReadToEnd();
        }

        // Termilly is told in the background, so the user's status line doesn't wait on it.
        var pane = Environment.GetEnvironmentVariable(Protocol.PaneVariable);
        var pipe = Environment.GetEnvironmentVariable(Protocol.PipeVariable);
        var tell = version == Protocol.Version.ToString() && !string.IsNullOrEmpty(pane) && !string.IsNullOrEmpty(pipe)
            ? Task.Run(() => Protocol.Send(pipe!, Message(pane!, payload), TellTimeout))
            : Task.CompletedTask;

        if (UserCommand(payload) is { } command)
        {
            stdout.Write(RunCommand(command, payload));
        }
        tell.Wait(TellWait);
        return 0;
    }

    /// <summary>
    /// The one-line message for Termilly: the session, its plan limits, its context figures and its cost. Nothing
    /// else in the status line's input (folders, transcript path) is passed on.
    /// </summary>
    public static string Message(string paneId, string? payloadJson)
    {
        JsonObject? payload = null;
        try
        {
            payload = string.IsNullOrWhiteSpace(payloadJson) ? null : JsonNode.Parse(payloadJson) as JsonObject;
        }
        catch (JsonException)
        {
        }
        var limits = new JsonObject();
        if (payload?[Input.RateLimits] is JsonObject rates)
        {
            foreach (var (from, to) in new[] { (Input.FiveHour, HookMessage.Fields.FiveHour), (Input.SevenDay, HookMessage.Fields.SevenDay) })
            {
                if (rates[from] is JsonObject window && Number(window, Input.UsedPercentage) is { } used)
                {
                    limits[to] = new JsonObject { [HookMessage.Fields.Used] = Math.Clamp(used, 0, MaxPercent), [HookMessage.Fields.ResetsAt] = Number(window, Input.ResetsAt) };
                }
            }
        }
        var session = payload?[Input.SessionId] is JsonValue id && id.TryGetValue<string>(out var text) && text.Length <= MaxSession ? text : null;
        var message = new JsonObject
        {
            [HookMessage.Fields.Version] = Protocol.Version,
            [HookMessage.Fields.Pane] = paneId,
            [HookMessage.Fields.Event] = HookEvents.StatusLine,
            [HookMessage.Fields.Session] = session,
            [HookMessage.Fields.Limits] = limits,
        };
        // Claude Code's own context figures (what its /context and status line go by): percent used, window size, and
        // the tokens in context after the last reply.
        if (payload?[Input.ContextWindow] is JsonObject context && Number(context, Input.UsedPercentage) is { } percent && Number(context, Input.ContextWindowSize) is { } size)
        {
            message[HookMessage.Fields.Context] = new JsonObject
            {
                [HookMessage.Fields.Used] = Math.Clamp(percent, 0, MaxPercent),
                [HookMessage.Fields.Size] = size,
                [HookMessage.Fields.Tokens] = Number(context, Input.TotalInputTokens),
            };
        }
        // Claude's own figure for the session (what /cost shows), and how long it has run. No price table needed.
        if (payload?[Input.Cost] is JsonObject cost && Number(cost, Input.TotalCostUsd) is { } usd)
        {
            message[HookMessage.Fields.Cost] = new JsonObject { [HookMessage.Fields.Usd] = Math.Max(0, usd), [HookMessage.Fields.DurationMs] = Number(cost, Input.TotalDurationMs) };
        }
        return message.ToJsonString();
    }

    private static double? Number(JsonObject o, string name) =>
        o[name] is JsonValue v && v.TryGetValue<double>(out var n) && double.IsFinite(n) ? n : null;

    /// <summary>
    /// The user's own status line command: from the project's .claude/settings.local.json, then its
    /// .claude/settings.json, then ~/.claude/settings.json (the first that has one wins), never Termilly's own.
    /// </summary>
    public static string? UserCommand(string? payloadJson, string? home = null)
    {
        string? project = null;
        try
        {
            if (JsonNode.Parse(payloadJson ?? "") is JsonObject payload)
            {
                project = (payload[Input.Workspace]?[Input.ProjectDir] ?? payload[Input.Workspace]?[Input.CurrentDir] ?? payload[Input.Cwd]) is JsonValue dir
                          && dir.TryGetValue<string>(out var d) ? d : null;
            }
        }
        catch (JsonException)
        {
        }
        var config = home ?? ClaudeCodeFiles.ConfigDirectory();
        var files = new List<string>();
        if (project is not null)
        {
            files.Add(Path.Combine(project, ClaudeCodeFiles.Folder, ClaudeCodeFiles.LocalSettings));
            files.Add(Path.Combine(project, ClaudeCodeFiles.Folder, ClaudeCodeFiles.Settings));
        }
        files.Add(Path.Combine(config, ClaudeCodeFiles.Settings));
        foreach (var file in files)
        {
            try
            {
                if (File.Exists(file) && JsonNode.Parse(File.ReadAllText(file)) is JsonObject settings &&
                    settings[Settings.StatusLine]?[Settings.Command] is JsonValue value && value.TryGetValue<string>(out var command) &&
                    !string.IsNullOrWhiteSpace(command))
                {
                    return command.Contains(AgentExecutables.Hook, StringComparison.OrdinalIgnoreCase) ? null : command;
                }
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException)
            {
            }
        }
        return null;
    }

    /// <summary>Runs a status line command the way Claude Code does (on Windows Git Bash, else cmd; elsewhere sh) and returns its output.</summary>
    private static string RunCommand(string command, string payload)
    {
        var bash = OperatingSystem.IsWindows() ? FindBash() : Shells.UnixShell;
        var start = new ProcessStartInfo(bash ?? Shells.Cmd)
        {
            UseShellExecute = false,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            CreateNoWindow = true,
        };
        if (bash is not null)
        {
            start.ArgumentList.Add("-c");
            start.ArgumentList.Add(command);
        }
        else
        {
            start.Arguments = "/d /s /c \"" + command + "\"";
        }
        try
        {
            using var process = Process.Start(start)!;
            var output = process.StandardOutput.ReadToEndAsync();
            _ = process.StandardError.ReadToEndAsync();
            process.StandardInput.Write(payload);
            process.StandardInput.Close();
            if (!process.WaitForExit(CommandTimeout))
            {
                process.Kill(entireProcessTree: true);
                return "";
            }
            return output.Result;
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return "";
        }
    }

    private static string? FindBash()
    {
        if (Environment.GetEnvironmentVariable(ClaudeCodeFiles.GitBashVariable) is { Length: > 0 } set && File.Exists(set))
        {
            return set;
        }
        foreach (var dir in (Environment.GetEnvironmentVariable(SystemVariables.Path) ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var git = Path.Combine(dir.Trim('"'), GitForWindows.GitExe);
            if (File.Exists(git))
            {
                // ...\Git\cmd\git.exe or ...\Git\bin\git.exe → ...\Git\bin\bash.exe
                var bash = Path.GetFullPath(Path.Combine(dir.Trim('"'), Shells.ParentFolder, GitForWindows.Bin, GitForWindows.BashExe));
                if (File.Exists(bash))
                {
                    return bash;
                }
            }
        }
        var standard = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), GitForWindows.Folder, GitForWindows.Bin, GitForWindows.BashExe);
        return File.Exists(standard) ? standard : null;
    }
}
