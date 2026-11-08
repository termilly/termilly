using System.IO;
using System.Text.Json.Nodes;

namespace Termilly.Desktop;

/// <summary>
/// Claude Code working on a To do task out of sight (js/todorun.js), asking the user for what it isn't allowed to do
/// instead of being refused: its permission prompts go to Termilly's MCP server's ask_permission (Termilly.Agent/Mcp.cs),
/// which waits for Allow or Deny in the task's row. Each run gets a config naming that server, with the run and the
/// window's pipe, removed when the run ends.
/// </summary>
internal static class AskingRun
{
    private const string Folder = "runs";
    private const string Extension = ".json";
    /// <summary>The MCP server's name in the config, which Claude Code puts before its tools' names.</summary>
    private const string Server = AgentExecutables.Cli;
    /// <summary>How long Claude Code waits for an MCP tool, in its environment (milliseconds): as long as the user may take.</summary>
    public const string ToolTimeoutVariable = "MCP_TOOL_TIMEOUT";

    /// <summary>Claude Code's MCP config: its servers, each started as a program with arguments and environment.</summary>
    private static class Config
    {
        public const string Servers = "mcpServers";
        public const string Type = "type";
        public const string Stdio = "stdio";
        public const string Command = "command";
        public const string Args = "args";
        public const string Env = "env";
    }

    /// <summary>What a run that can't ask is given: anything it would ask for is refused.</summary>
    public const string NobodyAsks = " --permission-prompts none";

    /// <summary>The config of a run's MCP server.</summary>
    public static string ConfigPath(string runId) => Path.Combine(Path.GetDirectoryName(AgentHooks.ClaudeSettingsPath)!, Folder, runId + Extension);

    /// <summary>
    /// Writes a run's config and returns what its command gets for asking: Claude Code's flags, the config's path quoted
    /// for <paramref name="shell"/> (a profile's shell icon).
    /// </summary>
    public static string Prepare(string runId, string shell, string pipe)
    {
        var path = ConfigPath(runId);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var config = new JsonObject
        {
            [Config.Servers] = new JsonObject
            {
                [Server] = new JsonObject
                {
                    [Config.Type] = Config.Stdio,
                    [Config.Command] = Path.Combine(AgentHooks.AgentDirectory, AppPaths.Exe(AgentExecutables.Cli)),
                    [Config.Args] = new JsonArray(AgentCommands.Mcp),
                    [Config.Env] = new JsonObject { [TerminalEnvironment.Pipe] = pipe, [TerminalEnvironment.Run] = runId },
                },
            },
        };
        File.WriteAllText(path, config.ToJsonString());
        return $" --permission-prompts host --permission-prompt-tool mcp__{Server}__{McpTools.AskPermission} --mcp-config {Quote(path, shell)}";
    }

    /// <summary>Removes a run's config, once it's ended.</summary>
    public static void Forget(string runId)
    {
        try
        {
            File.Delete(ConfigPath(runId));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // Left behind; it names nothing secret, and the next start's run ids are new.
        }
    }

    /// <summary>A path as <paramref name="shell"/> reads it: cmd in double quotes, PowerShell and the Unix shells in single ones.</summary>
    public static string Quote(string path, string shell) => shell switch
    {
        ProfileIcons.Cmd => $"\"{path}\"",
        ProfileIcons.PowerShell => $"'{path.Replace("'", "''")}'",
        _ => $"'{path.Replace("'", "'\\''")}'",
    };
}
