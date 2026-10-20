using System.IO;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using YamlDotNet.Core;
using YamlDotNet.RepresentationModel;

namespace Termilly.Desktop;

/// <summary>A layout read and checked (null when there's none to use), and what was wrong with it.</summary>
internal sealed record LayoutResult(JsonObject? Layout, List<string> Warnings);

/// <summary>
/// A workspace written down: its name, colour, folder and terminals with their split layout, names, tags, shell,
/// folder, start command and environment variables. Shared as a YAML file, and found as .termilly.yml in a
/// project folder. Reading is forgiving: unknown keys and bad values become warnings, not failures. Writing never
/// stores a secret.
/// </summary>
/// <example>
/// version: 1
/// name: api
/// layout:
///   split: row
///   panes:
///     - terminal: { name: server, command: npm run dev, tags: [dev] }
///     - split: column
///       panes:
///         - terminal: { name: tests, command: npm test -- --watch }
///         - tabs:
///             - terminal: { name: shell }
///             - terminal: { name: logs, command: npm run logs }
///           active: 0
/// </example>
internal static partial class WorkspaceLayout
{
    public const int Version = 1;
    /// <summary>A layout file's extension, as the export dialog adds it.</summary>
    public const string Extension = ".yml";
    public const string FileName = ".termilly" + Extension;
    private const int MaxTerminals = 16;
    private const int MaxDepth = 8;
    /// <summary>Longest note kept (characters), as in the page's note editor.</summary>
    private const int MaxNote = 4000;
    private const int MaxSnippets = 100;

    /// <summary>Longest workspace name kept, as the page's rename field allows.</summary>
    private const int MaxName = 40;
    private const int MaxTags = 8;
    private const double MinRatio = 0.1;
    private const double MaxRatio = 0.9;
    private const double EvenRatio = 0.5;
    private const int RatioDigits = 3;
    /// <summary>A split's whole, shared out between its panes.</summary>
    private const double Whole = 1.0;
    /// <summary>How YAML writes nothing, unquoted.</summary>
    private static readonly string[] YamlNulls = ["~", "null"];

    /// <summary>The keys of a layout file (and of the layout the page gets).</summary>
    internal static class Keys
    {
        public const string Version = "version";
        public const string Name = "name";
        public const string Color = "color";
        public const string Cwd = "cwd";
        public const string Notes = "notes";
        public const string Snippets = "snippets";
        public const string Layout = "layout";
        public const string Terminals = "terminals";
        public const string Terminal = "terminal";
        public const string Profile = "profile";
        public const string Command = "command";
        public const string Tags = "tags";
        public const string Env = "env";
        public const string Note = "note";
        public const string Split = "split";
        public const string Ratio = "ratio";
        public const string Panes = "panes";
        public const string Tabs = "tabs";
        public const string Active = "active";
        public const string Description = "description";
        public const string Enter = "enter";
    }

    /// <summary>A split's directions: side by side, or one above the other.</summary>
    private static class Splits
    {
        public const string Row = "row";
        public const string Column = "column";
    }

    private static readonly string[] TopKeys = [Keys.Version, Keys.Name, Keys.Color, Keys.Cwd, Keys.Notes, Keys.Snippets, Keys.Layout, Keys.Terminals];
    private static readonly string[] TerminalKeys = [Keys.Name, Keys.Profile, Keys.Cwd, Keys.Command, Keys.Tags, Keys.Env, Keys.Note];
    private static readonly string[] SplitKeys = [Keys.Split, Keys.Ratio, Keys.Panes];
    private static readonly string[] TabKeys = [Keys.Tabs, Keys.Active];
    /// <summary>A terminal's text settings, kept as they are.</summary>
    private static readonly string[] TerminalTexts = [Keys.Name, Keys.Profile, Keys.Command];

    [GeneratedRegex("^#[0-9a-fA-F]{6}$")]
    private static partial Regex Colour();

    /// <summary>Reads a layout file; folders in it are relative to <paramref name="baseDirectory"/>.</summary>
    public static LayoutResult Parse(string yaml, string baseDirectory)
    {
        var warnings = new List<string>();
        JsonNode? root;
        try
        {
            var stream = new YamlStream();
            stream.Load(new StringReader(yaml));
            root = stream.Documents.Count == 0 ? null : ToJson(stream.Documents[0].RootNode);
        }
        catch (YamlException e)
        {
            warnings.Add($"Not valid YAML (line {e.Start.Line}): {e.Message}");
            return new(null, warnings);
        }
        catch (Exception e) when (e is ArgumentException or InvalidCastException)
        {
            warnings.Add("A key is written twice in the same place, or a key isn't plain text.");
            return new(null, warnings);
        }
        if (root is not JsonObject top)
        {
            warnings.Add("The file has no layout in it.");
            return new(null, warnings);
        }
        return Normalize(top, baseDirectory, warnings);
    }

    /// <summary>Checks a layout (from a file or from the page) and resolves its folders.</summary>
    public static LayoutResult Normalize(JsonObject top, string? baseDirectory, List<string>? warnings = null)
    {
        warnings ??= [];
        Unknown(top, TopKeys, "the file", warnings);
        if (top[Keys.Version] is JsonValue v && v.TryGetValue<int>(out var version) && version > Version)
        {
            warnings.Add($"Written for layout version {version}; this Termilly reads version {Version}, so some of it may be ignored.");
        }

        var reader = new Reader(baseDirectory, warnings);
        var layout = top[Keys.Layout] is JsonObject node ? reader.Node(node, 0)
            // Shorthand: a list of terminals side by side.
            : top[Keys.Terminals] is JsonArray list ? Row(list.OfType<JsonObject>().Select(t => reader.Node(new JsonObject { [Keys.Terminal] = t.DeepClone() }, 0)).OfType<JsonObject>().ToList())
            : null;
        if (layout is null)
        {
            warnings.Add("No terminals: add a \"layout\" or a \"terminals\" list.");
            return new(null, warnings);
        }

        var result = new JsonObject { [Keys.Version] = Version, [Keys.Layout] = layout };
        if (Text(top, Keys.Name) is { } name)
        {
            result[Keys.Name] = name.Length > MaxName ? name[..MaxName] : name;
        }
        if (Text(top, Keys.Color) is { } color)
        {
            if (Colour().IsMatch(color))
            {
                result[Keys.Color] = color.ToLowerInvariant();
            }
            else
            {
                warnings.Add($"\"{color}\" isn't a colour like #8b7bff; the workspace gets the next colour instead.");
            }
        }
        if (Folder(top, baseDirectory, warnings) is { } cwd)
        {
            result[Keys.Cwd] = cwd;
        }
        // Notes a team shares on the workspace (Termilly pins them to its terminals' headers).
        if (Text(top, Keys.Notes) is { Length: > 0 } notes)
        {
            result[Keys.Notes] = notes.Length > MaxNote ? notes[..MaxNote] : notes;
        }
        if (top[Keys.Snippets] is JsonArray snippets && Snippets(snippets, warnings) is { Count: > 0 } kept)
        {
            result[Keys.Snippets] = kept;
        }
        return new(result, warnings);
    }

    /// <summary>Saved commands the team shares (js/snippets.js): name and command, optionally a description and enter: false.</summary>
    private static JsonArray Snippets(JsonArray snippets, List<string> warnings)
    {
        var list = new JsonArray();
        foreach (var s in snippets.OfType<JsonObject>().Take(MaxSnippets))
        {
            if (Text(s, Keys.Command) is not { Length: > 0 } command)
            {
                warnings.Add("A snippet without a command is left out.");
                continue;
            }
            var snippet = new JsonObject { [Keys.Name] = Text(s, Keys.Name) ?? command, [Keys.Command] = command };
            if (Text(s, Keys.Description) is { } description)
            {
                snippet[Keys.Description] = description;
            }
            // YAML gives "false" as text; JSON from the page as a boolean.
            if (bool.TryParse(s[Keys.Enter]?.ToString(), out var press))
            {
                snippet[Keys.Enter] = press;
            }
            list.Add(snippet);
        }
        return list;
    }

    private static JsonObject? Row(List<JsonObject> panes) => panes.Count switch
    {
        0 => null,
        1 => panes[0],
        _ => new JsonObject { [Keys.Split] = Splits.Row, [Keys.Ratio] = Math.Round(Whole / panes.Count, RatioDigits), [Keys.Panes] = new JsonArray(panes[0], Row(panes[1..])) },
    };

    /// <summary>Reads a layout's tree of panes, counting its terminals (past <see cref="MaxTerminals"/> they're left out).</summary>
    private sealed class Reader(string? baseDirectory, List<string> warnings)
    {
        private int _count;

        public JsonObject? Node(JsonObject node, int depth)
        {
            if (depth > MaxDepth)
            {
                warnings.Add("Splits nested too deep; the inner ones are left out.");
                return null;
            }
            if (node[Keys.Terminal] is JsonObject terminal)
            {
                return Terminal(terminal);
            }
            if (Text(node, Keys.Split) is { } split)
            {
                return Split(node, split, depth);
            }
            if (node[Keys.Tabs] is JsonArray tabList)
            {
                return Tabs(node, tabList, depth);
            }
            warnings.Add("A pane is neither a terminal, a split nor tabs; it's left out.");
            return null;
        }

        private JsonObject? Terminal(JsonObject terminal)
        {
            if (++_count > MaxTerminals)
            {
                if (_count == MaxTerminals + 1)
                {
                    warnings.Add($"More than {MaxTerminals} terminals; the rest are left out.");
                }
                return null;
            }
            Unknown(terminal, TerminalKeys, "a terminal", warnings);
            var result = new JsonObject();
            foreach (var key in TerminalTexts)
            {
                if (Text(terminal, key) is { } value)
                {
                    result[key] = value;
                }
            }
            if (Text(terminal, Keys.Note) is { Length: > 0 } note)
            {
                result[Keys.Note] = note.Length > MaxNote ? note[..MaxNote] : note;
            }
            if (Folder(terminal, baseDirectory, warnings) is { } cwd)
            {
                result[Keys.Cwd] = cwd;
            }
            if (terminal[Keys.Tags] is JsonArray tags)
            {
                result[Keys.Tags] = new JsonArray(tags.Select(t => t?.ToString().Trim()).Where(t => !string.IsNullOrEmpty(t)).Distinct().Take(MaxTags).Select(t => (JsonNode)t!).ToArray());
            }
            if (terminal[Keys.Env] is JsonObject env && Variables(env) is { Count: > 0 } vars)
            {
                result[Keys.Env] = vars;
            }
            return new JsonObject { [Keys.Terminal] = result };
        }

        /// <summary>The environment variables whose names are names; the others are left out with a warning.</summary>
        private JsonObject Variables(JsonObject env)
        {
            var vars = new JsonObject();
            foreach (var (key, value) in env)
            {
                if (SettingChecks.IsVariableName(key))
                {
                    vars[key] = value?.ToString() ?? "";
                }
                else
                {
                    warnings.Add($"\"{key}\" isn't a variable name; left out.");
                }
            }
            return vars;
        }

        private JsonObject? Split(JsonObject node, string split, int depth)
        {
            if (split is not (Splits.Row or Splits.Column))
            {
                warnings.Add($"split: \"{split}\" should be row (side by side) or column (one above the other); using row.");
                split = Splits.Row;
            }
            if (node[Keys.Panes] is not JsonArray { Count: >= 2 } panes)
            {
                warnings.Add("A split needs two panes; it's left out.");
                return null;
            }
            if (panes.Count > 2)
            {
                warnings.Add("A split has two panes; the extra ones are left out.");
            }
            var a = panes[0] is JsonObject first ? Node(first, depth + 1) : null;
            var b = panes[1] is JsonObject second ? Node(second, depth + 1) : null;
            if (a is null || b is null)
            {
                return a ?? b;
            }
            var ratio = node[Keys.Ratio] is JsonValue r && r.TryGetValue<double>(out var value) ? Math.Clamp(value, MinRatio, MaxRatio) : EvenRatio;
            Unknown(node, SplitKeys, "a split", warnings);
            return new JsonObject { [Keys.Split] = split, [Keys.Ratio] = ratio, [Keys.Panes] = new JsonArray(a, b) };
        }

        /// <summary>Terminals as tabs in one place; active is the one shown (0 is the first).</summary>
        private JsonObject? Tabs(JsonObject node, JsonArray tabList, int depth)
        {
            var items = new JsonArray();
            foreach (var item in tabList)
            {
                if (item is JsonObject pane && pane[Keys.Terminal] is JsonObject && Node(pane, depth + 1) is { } built)
                {
                    items.Add(built);
                }
                else if (item is not null)
                {
                    warnings.Add("A tab holds one terminal; anything else in tabs is left out.");
                }
            }
            Unknown(node, TabKeys, "a tab group", warnings);
            if (items.Count < 2)
            {
                return items.Count == 1 ? items[0]!.DeepClone().AsObject() : null;
            }
            var active = node[Keys.Active] is JsonValue a && a.TryGetValue<double>(out var index) && index >= 0 && index < items.Count ? (int)index : 0;
            return new JsonObject { [Keys.Tabs] = items, [Keys.Active] = active };
        }
    }

    /// <summary>A folder, made absolute against the layout file's folder ("." is the project itself).</summary>
    private static string? Folder(JsonObject node, string? baseDirectory, List<string> warnings)
    {
        if (Text(node, Keys.Cwd) is not { } cwd)
        {
            return null;
        }
        try
        {
            var expanded = Environment.ExpandEnvironmentVariables(cwd);
            return baseDirectory is null || Path.IsPathRooted(expanded) || expanded.StartsWith('~')
                ? expanded
                : Path.GetFullPath(Path.Combine(baseDirectory, expanded));
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            warnings.Add($"\"{cwd}\" isn't a usable folder.");
            return null;
        }
    }

    private static void Unknown(JsonObject node, string[] known, string where, List<string> warnings)
    {
        foreach (var (key, _) in node)
        {
            if (!known.Contains(key))
            {
                warnings.Add($"\"{key}\" in {where} isn't a layout setting; ignored.");
            }
        }
    }

    private static string? Text(JsonObject node, string key) =>
        node[key] is JsonValue value && value.ToString().Trim() is { Length: > 0 } text ? text : null;

    /// <summary>YAML to JSON: maps, lists and scalars (numbers and booleans stay as they were written).</summary>
    private static JsonNode? ToJson(YamlNode node) => node switch
    {
        YamlMappingNode map => new JsonObject(map.Children.Select(kv =>
            KeyValuePair.Create(((YamlScalarNode)kv.Key).Value ?? "", ToJson(kv.Value)))),
        YamlSequenceNode list => new JsonArray(list.Children.Select(ToJson).ToArray()),
        YamlScalarNode { Value: var value, Style: ScalarStyle.Plain } when double.TryParse(value, System.Globalization.CultureInfo.InvariantCulture, out var number) => JsonValue.Create(number),
        YamlScalarNode scalar => (scalar.Value is null || YamlNulls.Contains(scalar.Value)) && scalar.Style == ScalarStyle.Plain ? null : JsonValue.Create(scalar.Value),
        _ => null,
    };
}
