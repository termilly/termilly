using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// The Claude Code settings that add Termilly's hooks (and optionally its status line): the file the claude shim
/// passes with --settings on this PC, and the one installed on servers (RemoteIntegration).
/// </summary>
internal static class ClaudeHookSettings
{
    /// <summary>How long Claude Code lets one of Termilly's hooks run.</summary>
    private const int HookTimeoutSeconds = 5;
    /// <summary>A tool event's matcher for every tool.</summary>
    private const string EveryTool = "*";
    /// <summary>The user's own status line settings that Termilly's status line keeps.</summary>
    private static readonly string[] CopiedFromTheirs = ["padding", "refreshInterval"];
    private static readonly JsonSerializerOptions Indented = new() { WriteIndented = true };

    /// <summary>The keys of Claude Code's settings written.</summary>
    private static class Keys
    {
        public const string Hooks = "hooks";
        public const string StatusLine = "statusLine";
        public const string Type = "type";
        public const string Command = "command";
        public const string Timeout = "timeout";
        public const string Matcher = "matcher";
    }

    /// <summary>
    /// Writes the Claude Code settings file the shim passes with --settings. Claude Code runs hooks through Git
    /// Bash where it can, so the path uses forward slashes, which cmd accepts too.
    /// </summary>
    /// <remarks>
    /// With <paramref name="statusLine"/>, Termilly's status line too (Termilly.Agent/StatusLine.cs): it passes the plan's
    /// usage limits on and then runs the user's own status line, so theirs still shows. Its padding and refresh interval
    /// are copied from the user's settings (<paramref name="userSettings"/>, ~/.claude/settings.json).
    /// </remarks>
    public static void Write(string path, string hookExe, bool statusLine = false, string? userSettings = null)
    {
        var settings = new JsonObject { [Keys.Hooks] = Hooks($"\"{hookExe.Replace('\\', '/')}\" {HookCommands.Hook} {AgentHooks.Version}") };
        if (statusLine)
        {
            var line = new JsonObject { [Keys.Type] = Keys.Command, [Keys.Command] = $"\"{hookExe.Replace('\\', '/')}\" {HookCommands.StatusLine} {AgentHooks.Version}" };
            try
            {
                if (userSettings is not null && File.Exists(userSettings) && JsonNode.Parse(File.ReadAllText(userSettings))?[Keys.StatusLine] is JsonObject theirs)
                {
                    foreach (var name in CopiedFromTheirs)
                    {
                        if (theirs[name] is JsonValue value)
                        {
                            line[name] = value.DeepClone();
                        }
                    }
                }
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
            {
            }
            settings[Keys.StatusLine] = line;
        }
        AppPaths.WriteAtomically(path, settings.ToJsonString(Indented));
    }

    /// <summary>
    /// The settings file for Claude Code on a remote host (see RemoteIntegration): the same hooks, run by
    /// ~/.termilly/termilly-hook.sh, which reports them through the terminal instead of the pipe.
    /// </summary>
    public static string ForRemote() =>
        new JsonObject { [Keys.Hooks] = Hooks($"\"$HOME/.termilly/termilly-hook.sh\" {HookCommands.Hook} {AgentHooks.Version}") }
            .ToJsonString(Indented);

    /// <summary>A hooks section with <paramref name="command"/> plus the event's name for every event Termilly listens to.</summary>
    private static JsonObject Hooks(string command)
    {
        var hooks = new JsonObject();
        foreach (var (name, tools) in HookEvents.Claude)
        {
            var entry = new JsonObject
            {
                [Keys.Hooks] = new JsonArray(new JsonObject { [Keys.Type] = Keys.Command, [Keys.Command] = $"{command} {name}", [Keys.Timeout] = HookTimeoutSeconds }),
            };
            if (tools)
            {
                entry[Keys.Matcher] = EveryTool;
            }
            hooks[name] = new JsonArray(entry);
        }
        return hooks;
    }
}
