using System.Text.Json.Nodes;

namespace Termilly.Agent;

/// <summary>
/// The `termilly` command, on PATH in Termilly's terminals (agent\termilly.exe). From inside a terminal it talks
/// to its own Termilly window, and --pane defaults to the terminal it runs in.
/// </summary>
internal static class Cli
{
    public const string Help = """
        termilly: drive Termilly from a script or an agent.

          termilly list [--json]                       terminals, their workspace, state and folder
          termilly state [--pane ID]                   one terminal's details (default: this one)
          termilly status <text> [--pane ID]           show a status next to a terminal's title ("" clears)
          termilly open [--profile P] [--cwd DIR] [--name N] [--workspace W] [-- command...]
                                                       a new terminal, optionally running a command
          termilly send <text> [--pane ID] [--enter]   type into a terminal (allow it in Settings first)
          termilly snippet list [--json]               saved commands (Termilly's snippets) and their variables
          termilly snippet run <name> [--pane ID] [--var NAME=VALUE]...
                                                       run a snippet in a terminal (allow typing in Settings first)
          termilly read [--pane ID] [--lines N]        another terminal's last command and its output (or its last N lines)
          termilly wait [--pane ID] [--match REGEX] [--timeout S]
                                                       until its command finishes (or a line matches), then its output
          termilly history [words] [--failed] [--in FOLDER] [--limit N]
                                                       commands run, newest first (secrets redacted)
          termilly mcp                                 run as an MCP server (stdio) for coding agents
        """;

    /// <summary>The command's own words, where they aren't the API method's.</summary>
    private static class Commands
    {
        public const string Help = "help";
        public const string Mcp = "mcp";
        public const string List = "list";
        public const string Run = "run";
    }

    /// <summary>The command's options.</summary>
    private static class Options
    {
        public const string Help = "--help";
        public const string HelpShort = "-h";
        public const string Json = "--json";
        public const string Pane = "--pane";
        public const string Enter = "--enter";
        public const string Lines = "--lines";
        public const string Match = "--match";
        public const string Timeout = "--timeout";
        public const string Var = "--var";
        public const string Failed = "--failed";
        public const string In = "--in";
        public const string Limit = "--limit";
        public const string Profile = "--profile";
        public const string Cwd = "--cwd";
        public const string Name = "--name";
        public const string Workspace = "--workspace";
        /// <summary>What every option starts with.</summary>
        public const string Prefix = "--";
        /// <summary>What follows is the command to run.</summary>
        public const string EndOfOptions = "--";
    }

    /// <summary>Exit codes: done, failed, timed out.</summary>
    private const int Failed = 1;
    private const int TimedOut = 2;
    /// <summary>Column widths of a terminal list: id, title, workspace, state; and a snippet list's name.</summary>
    private const int IdWidth = -14;
    private const int TitleWidth = -24;
    private const int WorkspaceWidth = -16;
    private const int StateWidth = -14;
    private const int SnippetNameWidth = -28;

    public static int Run(string[] args)
    {
        try
        {
            return args switch
            {
                [] or [Commands.Help or Options.Help or Options.HelpShort, ..] => Print(Help),
                [Commands.Mcp, ..] => Mcp.Run(Console.In, Console.Out),
                [ApiMethods.List, .. var rest] => List(rest),
                [ApiMethods.State, .. var rest] => Print(Api.Pretty(Api.Call(ApiMethods.State, new JsonObject { [ApiFields.Pane] = Pane(rest) }))),
                [ApiMethods.Status, var text, .. var rest] => Done(Api.Call(ApiMethods.Status, new JsonObject { [ApiFields.Pane] = Pane(rest), [ApiFields.Text] = text })),
                [ApiMethods.Open, .. var rest] => Print(Api.Call(ApiMethods.Open, OpenArguments(rest))?[ApiFields.Id]?.ToString() ?? ""),
                [ApiMethods.Send, var text, .. var rest] => Done(Api.Call(ApiMethods.Send, new JsonObject { [ApiFields.Pane] = Pane(rest), [ApiFields.Text] = text, [ApiFields.Enter] = rest.Contains(Options.Enter) })),
                [ApiMethods.History, .. var rest] => History(rest),
                [ApiMethods.Read, .. var rest] => Output(Api.Call(ApiMethods.Read, ReadArguments(rest))),
                [ApiMethods.Wait, .. var rest] => Output(Api.Call(ApiMethods.Wait, WaitArguments(rest))),
                [ApiMethods.Snippet, Commands.List, .. var rest] => Snippets(rest),
                [ApiMethods.Snippet, Commands.Run, var name, .. var rest] => Print(Api.Call(ApiMethods.Snippet, new JsonObject { [ApiFields.Name] = name, [ApiFields.Pane] = Pane(rest), [ApiFields.Vars] = Vars(rest) })?[ApiFields.Command]?.ToString() ?? ""),
                _ => Fail($"Unknown command. {Help}"),
            };
        }
        catch (ApiException e)
        {
            return Fail(e.Message);
        }
    }

    private static int Snippets(string[] args)
    {
        var snippets = Api.Call(ApiMethods.Snippets)?.AsArray() ?? [];
        if (args.Contains(Options.Json))
        {
            return Print(Api.Pretty(snippets));
        }
        foreach (var s in snippets)
        {
            Console.WriteLine($"{s?[ApiFields.Name],SnippetNameWidth} {s?[ApiFields.Command]}");
        }
        return 0;
    }

    private static JsonObject ReadArguments(string[] args)
    {
        var request = new JsonObject { [ApiFields.Pane] = Pane(args), [ApiFields.What] = Option(args, Options.Lines) is null ? ApiReadModes.LastCommand : ApiReadModes.Lines };
        if (int.TryParse(Option(args, Options.Lines), out var count))
        {
            request[ApiFields.Count] = count;
        }
        return request;
    }

    private static JsonObject WaitArguments(string[] args)
    {
        var request = new JsonObject { [ApiFields.Pane] = Pane(args), [ApiFields.Until] = Option(args, Options.Match) is null ? ApiReadModes.CommandFinished : ApiReadModes.OutputMatches, [ApiFields.Pattern] = Option(args, Options.Match) };
        if (int.TryParse(Option(args, Options.Timeout), out var seconds))
        {
            request[ApiFields.TimeoutSeconds] = seconds;
        }
        return request;
    }

    /// <summary>A read or wait result for a script: the command and its exit code on top, then the lines.</summary>
    private static int Output(JsonNode? result)
    {
        if (result?[ApiFields.TimedOut]?.GetValue<bool>() == true)
        {
            Console.Error.WriteLine("Timed out.");
            return TimedOut;
        }
        if (result?[ApiFields.Command]?.ToString() is { Length: > 0 } command)
        {
            Console.WriteLine($"$ {command}{(result[ApiFields.ExitCode] is { } code ? $"  [exit {code}]" : "")}");
        }
        if (result?[ApiFields.Matched]?.ToString() is { Length: > 0 } matched)
        {
            Console.WriteLine(matched);
        }
        foreach (var line in result?[ApiFields.Lines]?.AsArray() ?? [])
        {
            Console.WriteLine(line?.ToString());
        }
        return 0;
    }

    /// <summary>--var NAME=VALUE options, as a JSON object.</summary>
    private static JsonObject Vars(string[] args)
    {
        var vars = new JsonObject();
        for (var i = 0; i < args.Length - 1; i++)
        {
            if (args[i] == Options.Var && args[i + 1].IndexOf('=') is > 0 and var eq)
            {
                vars[args[i + 1][..eq]] = args[i + 1][(eq + 1)..];
            }
        }
        return vars;
    }

    private static int List(string[] args)
    {
        var panes = Api.Call(ApiMethods.List)?.AsArray() ?? [];
        if (args.Contains(Options.Json))
        {
            return Print(Api.Pretty(panes));
        }
        foreach (var p in panes)
        {
            var state = p?[ApiFields.Agent]?.ToString() ?? (p?[ApiFields.Busy]?.ToString() is { Length: > 0 } busy ? $"running {busy}" : "");
            Console.WriteLine($"{p?[ApiFields.Id],IdWidth} {p?[ApiFields.Title],TitleWidth} {p?[ApiFields.Workspace],WorkspaceWidth} {state,StateWidth} {p?[ApiFields.Cwd]}");
        }
        return 0;
    }

    private static int History(string[] args)
    {
        var words = args.TakeWhile(a => !a.StartsWith(Options.Prefix)).ToList();
        var request = new JsonObject
        {
            [ApiFields.Query] = string.Join(' ', words),
            [ApiFields.Failed] = args.Contains(Options.Failed) ? true : null,
            [ApiFields.In] = Option(args, Options.In),
            [ApiFields.Limit] = int.TryParse(Option(args, Options.Limit), out var limit) ? limit : ApiDefaults.HistoryLimit,
        };
        foreach (var entry in Api.Call(ApiMethods.History, request)?.AsArray() ?? [])
        {
            var code = entry?[ApiFields.ExitCode]?.ToString() ?? "?";
            Console.WriteLine($"{(code == "0" ? "  " : "x ")}{entry?[ApiFields.Command]}    [{code}] {entry?[ApiFields.Cwd]}");
        }
        return 0;
    }

    /// <summary>
    /// "open" arguments; everything after "--" is the command to run. Its words go as a list too (argv), each one as
    /// it was given, so the app can quote them for the terminal's shell: `-- claude "a prompt (with brackets)"` must
    /// reach PowerShell as one quoted argument, not as code. "command" (the words joined) is for older apps.
    /// </summary>
    public static JsonObject OpenArguments(string[] args)
    {
        var dash = Array.IndexOf(args, Options.EndOfOptions);
        var options = dash < 0 ? args : args[..dash];
        var cwd = Option(options, Options.Cwd);
        var words = dash < 0 ? null : args[(dash + 1)..];
        return new JsonObject
        {
            [ApiFields.Profile] = Option(options, Options.Profile),
            [ApiFields.Cwd] = cwd is null ? null : Path.GetFullPath(cwd),
            [ApiFields.Name] = Option(options, Options.Name),
            [ApiFields.Workspace] = Option(options, Options.Workspace),
            [ApiFields.Command] = words is null ? null : string.Join(' ', words),
            [ApiFields.Argv] = words is null ? null : new JsonArray(words.Select(w => (JsonNode?)w).ToArray()),
        };
    }

    /// <summary>--pane ID, else the terminal this runs in.</summary>
    public static string? Pane(string[] args) => Option(args, Options.Pane) ?? Environment.GetEnvironmentVariable(Protocol.PaneVariable);

    public static string? Option(string[] args, string name)
    {
        var i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static int Print(string text)
    {
        Console.WriteLine(text);
        return 0;
    }

    private static int Done(JsonNode? _) => 0;

    private static int Fail(string message)
    {
        Console.Error.WriteLine($"termilly: {message}");
        return Failed;
    }
}
