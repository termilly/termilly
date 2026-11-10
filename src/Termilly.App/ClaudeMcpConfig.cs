using System.IO;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Claude Code's MCP config naming Termilly's MCP server (`termilly mcp`, Termilly.Agent/Mcp.cs), given with
/// --mcp-config: the one the claude shim adds for every Claude Code in a Termilly terminal (<see cref="Write"/>), and each
/// out-of-sight run's own (AskingRun). Neither touches the user's config; theirs adds to it, and a server of theirs with
/// the same name gives way to this one for that run.
/// </summary>
internal static class ClaudeMcpConfig
{
    /// <summary>The server's name, which Claude Code puts before its tools' names (mcp__termilly__list_terminals).</summary>
    public const string Server = AgentExecutables.Cli;

    /// <summary>Claude Code's MCP config: its servers, each started as a program with arguments and environment.</summary>
    private static class Keys
    {
        public const string Servers = "mcpServers";
        public const string Type = "type";
        public const string Stdio = "stdio";
        public const string Command = "command";
        public const string Args = "args";
        public const string Env = "env";
    }

    /// <summary>The helper that serves MCP (termilly(.exe) in the agent folder).</summary>
    public static string ServerProgram => Path.Combine(AgentHooks.AgentDirectory, AppPaths.Exe(AgentExecutables.Cli));

    /// <summary>
    /// The config with Termilly's server and, when given, its environment. Without one, the server has Claude Code's
    /// own, which names its terminal and Termilly's window (TERMILLY_PANE_ID, TERMILLY_PIPE).
    /// </summary>
    public static JsonObject Of(JsonObject? environment = null)
    {
        var server = new JsonObject
        {
            [Keys.Type] = Keys.Stdio,
            [Keys.Command] = ServerProgram,
            [Keys.Args] = new JsonArray(AgentCommands.Mcp),
        };
        if (environment is not null)
        {
            server[Keys.Env] = environment;
        }
        return new JsonObject { [Keys.Servers] = new JsonObject { [Server] = server } };
    }

    /// <summary>
    /// Writes the config the claude shim adds with --mcp-config (Termilly.Agent/Shim.cs), next to the hooks' settings, so
    /// Claude Code in a Termilly terminal has Termilly's tools without `claude mcp add`. Rewritten at every start: the
    /// app's folder may have moved.
    /// </summary>
    public static void Write(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        AppPaths.WriteAtomically(path, Of().ToJsonString());
    }
}
