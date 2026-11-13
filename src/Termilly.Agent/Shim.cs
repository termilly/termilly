using System.Diagnostics;
using System.Text;

namespace Termilly.Agent;

/// <summary>
/// Runs as claude or codex (claude.exe, codex.exe on Windows) from Termilly's agent folder, which terminals have first
/// on PATH. Starts the real agent with Termilly's hooks and MCP server added and passes its exit code back: Claude Code
/// gets them with --settings and --mcp-config, Codex as -c values (both add to the user's own hooks and servers, they
/// don't replace them, and neither touches the user's config; a server of theirs named termilly gives way to Termilly's
/// for that run). Outside Termilly, or for an agent started from inside a hooked one, the shim adds nothing.
/// </summary>
internal static class Shim
{
    /// <summary>The exit code cmd gives for a command it can't find.</summary>
    private const int CommandNotFound = 9009;

    /// <summary>The agents' names in what the shim says.</summary>
    private static string ProductName(string agent) => agent == AgentKinds.Codex ? AgentKinds.CodexName : AgentKinds.ClaudeName;

    public static int Run(string agent, string[] args)
    {
        var real = FindReal(agent, Environment.GetEnvironmentVariable(SystemVariables.Path),
            Environment.GetEnvironmentVariable(SystemVariables.PathExt), AppContext.BaseDirectory);
        if (real is null)
        {
            Console.Error.WriteLine($"{agent}: {ProductName(agent)} isn't installed (no {agent} found on PATH besides Termilly's).");
            return CommandNotFound;
        }

        var start = new ProcessStartInfo(real) { UseShellExecute = false };
        // The settings file is there while the agent integration is on in Termilly's Settings (Codex's hooks need no
        // file, but follow the same switch).
        var settings = Environment.GetEnvironmentVariable(Protocol.SettingsVariable);
        if (Environment.GetEnvironmentVariable(Protocol.ShimVariable) != "1" && File.Exists(settings))
        {
            var added = agent == AgentKinds.Codex
                ? CodexArguments(Beside(AgentExecutables.Cli), OperatingSystem.IsWindows())
                : ClaudeArguments(settings!);
            if (agent == AgentKinds.Codex)
            {
                // Its hooks name the helper by this variable, which Codex hands on to them with the rest of its environment.
                start.Environment[Protocol.HookProgramVariable] = Beside(AgentExecutables.Hook);
            }
            foreach (var arg in added)
            {
                start.ArgumentList.Add(arg);
            }
            start.Environment[Protocol.ShimVariable] = "1";
        }
        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        // Ctrl+C reaches every process in the console; the agent decides what it means, the shim just waits.
        Console.CancelKeyPress += (_, e) => e.Cancel = true;
        using var process = Process.Start(start)!;
        process.WaitForExit();
        return process.ExitCode;
    }

    /// <summary>
    /// What Claude Code gets: Termilly's hooks (--settings) and, when Termilly wrote it, its MCP server (--mcp-config, the
    /// file next to the settings), so its tools are there without `claude mcp add`. --mcp-config takes any number of
    /// files, so it comes first: --settings, which takes one, ends its list, and the user's own prompt or subcommand after
    /// it isn't read as another config.
    /// </summary>
    public static List<string> ClaudeArguments(string settings)
    {
        var args = new List<string>();
        var mcp = Path.Combine(Path.GetDirectoryName(settings) ?? "", AgentFiles.ClaudeMcp);
        if (File.Exists(mcp))
        {
            args.Add("--mcp-config");
            args.Add(mcp);
        }
        args.Add("--settings");
        args.Add(settings);
        return args;
    }

    /// <summary>The first real <paramref name="agent"/> on PATH: not this shim, nor another Termilly's (AgentLookup).</summary>
    public static string? FindReal(string agent, string? path, string? pathExt, string shimDirectory) =>
        AgentLookup.FindReal(agent, path, pathExt, shimDirectory);

    /// <summary>One of the helper's other names in its folder (termilly-hook.exe on Windows).</summary>
    private static string Beside(string name) =>
        Path.Combine(AppContext.BaseDirectory, OperatingSystem.IsWindows() ? name + AgentLookup.WindowsExe : name);

    /// <summary>Codex's option that sets one config value for this run.</summary>
    private const string ConfigOption = "-c";

    /// <summary>The termilly MCP server's name in Codex's config, which Codex puts before its tools' names.</summary>
    public const string CodexMcpServer = "termilly";

    /// <summary>How long Codex lets one of Termilly's hooks run (Interrupt's limit is 3 seconds).</summary>
    private const int CodexHookTimeoutSeconds = 3;

    /// <summary>How long a termilly tool may take: waiting on a terminal's output takes up to two minutes.</summary>
    private static readonly int CodexToolTimeoutSeconds = (int)PipeTimeouts.ApiWaiting.TotalSeconds + 10;

    /// <summary>
    /// The -c values that add Termilly's hooks and MCP server to Codex for this run: a hook for each event Termilly
    /// listens to, running the helper (termilly-hook hook 1 SessionStart codex). Codex asks once whether to trust
    /// hooks it hasn't seen, and remembers each by its exact definition. So a definition must be the same from run to
    /// run, and from one Termilly to the next: with the helper's path in it, every place Termilly ran from (an update's
    /// new folder, a build of one's own) made them hooks Codex hadn't seen, to review again. The helper is named by a
    /// variable instead (<see cref="Protocol.HookProgramVariable"/>, which the shim sets to its path for this Codex).
    /// Codex runs a hook's command with PowerShell on Windows (a program in a variable needs &amp; there) and sh elsewhere.
    /// </summary>
    /// <remarks>
    /// On Windows npm installs Codex as codex.cmd, and cmd reads the arguments again: a double quote in one ends its
    /// quoting there and lets cmd run what follows an &amp;. So the values have no double quotes at all (TOML's literal
    /// strings), and each arrives as one quoted argument cmd leaves alone.
    /// </remarks>
    public static List<string> CodexArguments(string cliExe, bool windows)
    {
        var program = windows ? $"& $env:{Protocol.HookProgramVariable}" : $"\"${Protocol.HookProgramVariable}\"";
        var args = new List<string>();
        foreach (var (name, tools) in HookEvents.Codex)
        {
            var command = $"{program} {HookCommands.Hook} {Protocol.Version} {name} {AgentKinds.Codex}";
            var matcher = tools ? "matcher='*'," : "";
            args.Add(ConfigOption);
            args.Add($"hooks.{name}=[{{{matcher}hooks=[{{type='command',command={Toml(command)},timeout={CodexHookTimeoutSeconds}}}]}}]");
        }
        // Codex passes MCP servers only the variables named: these say which terminal and Termilly window it's in.
        args.Add(ConfigOption);
        args.Add($"mcp_servers.{CodexMcpServer}={{command={Toml(cliExe)},args=['{AgentCommands.Mcp}']," +
            $"env_vars=['{Protocol.PaneVariable}','{Protocol.PipeVariable}'],tool_timeout_sec={CodexToolTimeoutSeconds}}}");
        // Inline, as Claude Code is, rather than on the alternate screen: there Codex takes the mouse, so Termilly's
        // right-click menu, its file and web links, selecting and the scrollback (searching it, history) didn't work.
        // A -c of the user's own after these still wins.
        args.Add(ConfigOption);
        args.Add($"{CodexAltScreen}='{CodexAltScreenNever}'");
        return args;
    }

    /// <summary>Codex's setting for the alternate screen (auto, always, never), and the value that keeps it inline.</summary>
    private const string CodexAltScreen = "tui.alternate_screen";
    private const string CodexAltScreenNever = "never";

    /// <summary>The quotes of TOML's multi-line literal string, which takes any text but three of them in a row.</summary>
    private const string LiteralQuotes = "'''";

    /// <summary>
    /// <paramref name="text"/> as a TOML string without double quotes: a literal string ('...', no escapes), or a
    /// multi-line literal one ('''...''') when it has single quotes. A text with three in a row (no real path has them)
    /// needs a basic string, double quotes and all.
    /// </summary>
    private static string Toml(string text)
    {
        if (!text.Contains('\'') && !text.Contains('\n'))
        {
            return $"'{text}'";
        }
        if (!text.Contains(LiteralQuotes) && !text.StartsWith('\n') && !text.EndsWith("''"))
        {
            return LiteralQuotes + text + LiteralQuotes;
        }
        var s = new StringBuilder("\"");
        foreach (var c in text)
        {
            s.Append(c switch
            {
                '"' => "\\\"",
                '\\' => "\\\\",
                < ' ' => $"\\u{(int)c:X4}",
                _ => c.ToString(),
            });
        }
        return s.Append('"').ToString();
    }
}
