using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// A repository's VS Code tasks (.vscode/tasks.json, JSON with comments), as commands Termilly can type: shell and
/// process tasks, with this OS's overrides (windows, linux, osx), args quoted, variables filled in and each
/// ${input:id} a {{id}} placeholder the run form asks for. Tasks of other types (npm, gulp and the like, which VS Code's
/// extensions run) are left out.
/// </summary>
internal static partial class VsCodeTasks
{
    public const string Folder = ".vscode";
    public const string FileName = "tasks.json";
    private const int MaxTasks = 200;
    private const string EnvPrefix = "env:";
    private const string InputPrefix = "input:";

    private static class Keys
    {
        public const string Tasks = "tasks";
        public const string Inputs = "inputs";
        public const string Label = "label";
        /// <summary>tasks.json 0.1.0's name for the label.</summary>
        public const string TaskName = "taskName";
        public const string Type = "type";
        public const string Command = "command";
        public const string Args = "args";
        public const string Value = "value";
        public const string Options = "options";
        public const string Cwd = "cwd";
        public const string Env = "env";
        public const string Group = "group";
        public const string Kind = "kind";
        public const string IsDefault = "isDefault";
        public const string DependsOn = "dependsOn";
        public const string Hide = "hide";
        public const string Id = "id";
        public const string Description = "description";
        public const string Default = "default";
        public const string Password = "password";
    }

    /// <summary>The task types that are a command (no type is a shell task, as tasks.json 0.1.0 had them).</summary>
    private static readonly string[] CommandTypes = ["shell", "process"];
    private static readonly string[] InputTypes = ["promptString", "pickString"];

    private static readonly JsonDocumentOptions Jsonc = new() { CommentHandling = JsonCommentHandling.Skip, AllowTrailingCommas = true };

    /// <summary>This OS's key for a task's overrides.</summary>
    private static string PlatformKey => OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "osx" : "linux";

    [GeneratedRegex(@"\$\{([^}]+)\}")]
    private static partial Regex Variable();

    [GeneratedRegex(@"[\s""'&|<>;()]")]
    private static partial Regex NeedsQuotes();

    /// <summary>The file's tasks and inputs; what couldn't be read is said in <paramref name="warnings"/>.</summary>
    public static (IReadOnlyList<RepoTask> Tasks, IReadOnlyList<TaskInput> Inputs) Parse(string json, string root, List<string> warnings)
    {
        JsonNode? doc;
        try
        {
            doc = JsonNode.Parse(json, documentOptions: Jsonc);
        }
        catch (JsonException e)
        {
            warnings.Add($"{FileName} isn't valid JSON: {e.Message}");
            return ([], []);
        }
        if (doc is not JsonObject top)
        {
            return ([], []);
        }
        // Options for every task (the file's own, then this OS's), under each task's own.
        var shared = Overlay(Pick(top, Keys.Options), Pick(top[PlatformKey] as JsonObject, Keys.Options));
        var tasks = (top[Keys.Tasks] as JsonArray ?? []).OfType<JsonObject>().Take(MaxTasks)
            .Select(t => Task(t, shared, root)).OfType<RepoTask>().ToList();
        var inputs = (top[Keys.Inputs] as JsonArray ?? []).OfType<JsonObject>().Select(Input).OfType<TaskInput>().ToList();
        return (tasks, inputs);
    }

    private static RepoTask? Task(JsonObject task, JsonObject? sharedOptions, string root)
    {
        var os = task[PlatformKey] as JsonObject;
        var type = Text(task, Keys.Type) ?? CommandTypes[0];
        var label = Text(task, Keys.Label) ?? Text(task, Keys.TaskName);
        if (label is null || !CommandTypes.Contains(type))
        {
            return null;
        }
        var command = CommandLine(os?[Keys.Command] ?? task[Keys.Command], os?[Keys.Args] ?? task[Keys.Args], root);
        var dependsOn = DependsOn(task[Keys.DependsOn]);
        if (command.Length == 0 && dependsOn.Count == 0)
        {
            return null;
        }
        var options = Overlay(Overlay(sharedOptions, Pick(task, Keys.Options)), Pick(os, Keys.Options));
        var cwd = options?[Keys.Cwd] is JsonValue c ? Fill(c.ToString(), root) : null;
        var env = (options?[Keys.Env] as JsonObject)?.ToDictionary(kv => kv.Key, kv => Fill(kv.Value?.ToString() ?? "", root));
        var (group, isDefault) = Group(task[Keys.Group]);
        return new RepoTask(label, command, cwd, env, group, isDefault, Flag(task[Keys.Hide]), dependsOn);
    }

    /// <summary>
    /// The command and its args as one line, variables filled in first: an arg with spaces or shell characters (a
    /// folder filled in can have them), or an empty one, in double quotes.
    /// </summary>
    private static string CommandLine(JsonNode? command, JsonNode? args, string root)
    {
        var parts = new List<string>();
        if (Value(command) is { Length: > 0 } c)
        {
            parts.Add(Fill(c, root));
        }
        foreach (var arg in (args as JsonArray ?? []).Select(Value).OfType<string>().Select(a => Fill(a, root)))
        {
            parts.Add((arg.Length == 0 || NeedsQuotes().IsMatch(arg)) && !IsQuoted(arg) ? $"\"{arg.Replace("\"", "\\\"")}\"" : arg);
        }
        return string.Join(' ', parts).Trim();
    }

    private static bool IsQuoted(string arg) => arg.Length > 1 && arg[0] == arg[^1] && arg[0] is '"' or '\'';

    /// <summary>A command or arg: a string, or { value, quoting } (an array value is its parts joined).</summary>
    private static string? Value(JsonNode? node) => node switch
    {
        JsonValue v => v.ToString(),
        JsonObject o => Value(o[Keys.Value]),
        JsonArray a => string.Join(' ', a.Select(Value).OfType<string>()),
        _ => null,
    };

    private static List<string> DependsOn(JsonNode? node) => node switch
    {
        JsonValue v => [v.ToString()],
        JsonArray a => [.. a.Select(n => n is JsonObject o ? Text(o, Keys.Label) ?? Text(o, "task") : Value(n)).OfType<string>()],
        _ => [],
    };

    /// <summary>"build", or { kind: "build", isDefault: true }.</summary>
    private static (string? Kind, bool IsDefault) Group(JsonNode? node) => node switch
    {
        JsonValue v => (v.ToString(), false),
        JsonObject o => (Text(o, Keys.Kind), Flag(o[Keys.IsDefault])),
        _ => (null, false),
    };

    private static TaskInput? Input(JsonObject input)
    {
        if (Text(input, Keys.Id) is not { } id || !InputTypes.Contains(Text(input, Keys.Type)))
        {
            return null;
        }
        var options = (input[Keys.Options] as JsonArray)?.Select(o => o is JsonObject x ? Value(x[Keys.Value]) : Value(o)).OfType<string>().ToList();
        return new TaskInput(id, Text(input, Keys.Description), Text(input, Keys.Default), options, Flag(input[Keys.Password]));
    }

    /// <summary>
    /// Fills in the variables Termilly knows: the repository's folder and name, the home folder, the path separator and
    /// environment variables; ${input:id} becomes {{id}}. Others (${file} and the editor's) stay as they are.
    /// </summary>
    public static string Fill(string text, string root) => Variable().Replace(text, m =>
    {
        var name = m.Groups[1].Value;
        if (name.StartsWith(EnvPrefix, StringComparison.Ordinal))
        {
            return Environment.GetEnvironmentVariable(name[EnvPrefix.Length..]) ?? "";
        }
        if (name.StartsWith(InputPrefix, StringComparison.Ordinal))
        {
            return $"{{{{{name[InputPrefix.Length..]}}}}}";
        }
        return name switch
        {
            "workspaceFolder" or "workspaceRoot" or "cwd" => root,
            "workspaceFolderBasename" => Path.GetFileName(root),
            "userHome" => Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "pathSeparator" or "/" => Path.DirectorySeparatorChar.ToString(),
            _ => m.Value,
        };
    });

    /// <summary>A copy of <paramref name="under"/> with <paramref name="over"/>'s keys on top (env merged key by key).</summary>
    private static JsonObject? Overlay(JsonObject? under, JsonObject? over)
    {
        if (under is null || over is null)
        {
            return (under ?? over)?.DeepClone() as JsonObject;
        }
        var result = (JsonObject)under.DeepClone();
        foreach (var (key, value) in over)
        {
            result[key] = key == Keys.Env && result[key] is JsonObject env && value is JsonObject more
                ? Overlay(env, more)
                : value?.DeepClone();
        }
        return result;
    }

    private static JsonObject? Pick(JsonObject? node, string key) => node?[key] as JsonObject;

    private static string? Text(JsonObject node, string key) =>
        node[key] is JsonValue v && v.ToString().Trim() is { Length: > 0 } text ? text : null;

    private static bool Flag(JsonNode? node) => node is JsonValue v && (v.TryGetValue<bool>(out var b) ? b : bool.TryParse(v.ToString(), out var s) && s);
}
