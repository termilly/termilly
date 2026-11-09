using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>A plugin as the page gets it: what its manifest declares, its script, or why it can't load.</summary>
internal sealed record PluginInfo(
    string Id, string Name, string? Version, string? Description, string Folder,
    IReadOnlyList<JsonObject> Themes, string? Script, string? Error);

/// <summary>
/// Plugins from &lt;data&gt;\plugins\&lt;folder&gt;\plugin.json. The manifest names the plugin API version it was written
/// for; themes are plain data (terminal colours); an optional main.js runs in a sandboxed frame on the page with no
/// access to the app, the host or the network, only to a small message API (js/plugins.js) over the same commands
/// as the termilly CLI. Anything wrong (unreadable manifest, a newer API, bad values) disables that plugin with
/// the reason instead of affecting the app.
/// </summary>
internal static partial class Plugins
{
    public const int ApiVersion = 1;
    private const int MaxScriptBytes = 256 * 1024;
    private const int MaxPlugins = 50;
    private const int MaxThemes = 20;
    private const string ManifestFile = "plugin.json";

    /// <summary>The terminal colour keys a theme may set (xterm's ITheme).</summary>
    private static readonly string[] ColorKeys =
    [
        "background", "foreground", "cursor", "cursorAccent", "selectionBackground",
        "black", "red", "green", "yellow", "blue", "magenta", "cyan", "white",
        "brightBlack", "brightRed", "brightGreen", "brightYellow", "brightBlue", "brightMagenta", "brightCyan", "brightWhite",
    ];

    public static string FolderPath => Path.Combine(AppPaths.DataDirectory, "plugins");

    public static List<PluginInfo> Load() => Load(FolderPath);

    public static List<PluginInfo> Load(string root)
    {
        var plugins = new List<PluginInfo>();
        if (!Directory.Exists(root))
        {
            return plugins;
        }
        foreach (var folder in Directory.EnumerateDirectories(root).Order(StringComparer.OrdinalIgnoreCase).Take(MaxPlugins))
        {
            var plugin = Read(folder);
            if (plugin.Error is null && plugins.Any(p => p.Id == plugin.Id))
            {
                plugin = plugin with { Error = $"Another plugin already has the id \"{plugin.Id}\"." };
            }
            plugins.Add(plugin);
        }
        return plugins;
    }

    /// <summary>One plugin folder: the manifest checked and cleaned, or the reason it can't load.</summary>
    public static PluginInfo Read(string folder)
    {
        var name = Path.GetFileName(folder);
        PluginInfo Broken(string error, string? id = null) => new(id ?? name, name, null, null, folder, [], null, error);
        if (ReadManifest(folder, out var manifest) is { } unreadable)
        {
            return Broken(unreadable);
        }
        var id = Text(manifest, Keys.Id);
        if (id is null || !IdPattern().IsMatch(id))
        {
            return Broken("plugin.json needs an \"id\": lower-case letters, digits, dots and dashes (e.g. \"acme.solarized\").");
        }
        if (CheckApi(manifest) is { } api)
        {
            return Broken(api, id);
        }
        if (ReadThemes(manifest, id, out var themes) is { } badTheme)
        {
            return Broken(badTheme, id);
        }
        if (ReadScript(manifest, folder, out var script) is { } badScript)
        {
            return Broken(badScript, id);
        }
        if (themes.Count == 0 && script is null)
        {
            return Broken("It has neither themes nor a script (\"main\").", id);
        }
        return new PluginInfo(id, Text(manifest, Keys.Name) ?? id, Text(manifest, Keys.Version), Text(manifest, Keys.Description), folder, themes, script, null);
    }

    /// <summary>The manifest keys read, and those of the themes the page gets.</summary>
    private static class Keys
    {
        public const string Id = "id";
        public const string Name = "name";
        public const string Version = "version";
        public const string Description = "description";
        public const string ApiVersion = "apiVersion";
        public const string Themes = "themes";
        public const string Colors = "colors";
        public const string Light = "light";
        public const string Main = "main";
    }

    /// <summary>Reads plugin.json; the reason when it's missing or not a JSON object.</summary>
    private static string? ReadManifest(string folder, out JsonObject manifest)
    {
        manifest = [];
        var manifestPath = Path.Combine(folder, ManifestFile);
        if (!File.Exists(manifestPath))
        {
            return "No plugin.json in its folder.";
        }
        try
        {
            manifest = JsonNode.Parse(File.ReadAllText(manifestPath)) as JsonObject ?? throw new JsonException("not an object");
            return null;
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            return $"plugin.json can't be read: {e.Message}";
        }
    }

    /// <summary>Why the plugin's API version isn't this Termilly's, if it isn't.</summary>
    private static string? CheckApi(JsonObject manifest)
    {
        if (manifest[Keys.ApiVersion] is not JsonValue v || !v.TryGetValue<int>(out var api))
        {
            return $"plugin.json needs \"apiVersion\": {ApiVersion}.";
        }
        if (api == ApiVersion)
        {
            return null;
        }
        return api > ApiVersion
            ? $"It needs plugin API {api}; this Termilly has {ApiVersion}. Update Termilly to use it."
            : $"It was written for plugin API {api}, which this Termilly no longer supports.";
    }

    /// <summary>The plugin's themes, ids prefixed with the plugin's and only known colour keys kept; the reason one is wrong.</summary>
    private static string? ReadThemes(JsonObject manifest, string id, out List<JsonObject> themes)
    {
        themes = [];
        if (manifest[Keys.Themes] is not JsonArray themeList)
        {
            return null;
        }
        foreach (var theme in themeList.OfType<JsonObject>().Take(MaxThemes))
        {
            var themeId = Text(theme, Keys.Id);
            var colors = Colors(theme[Keys.Colors] as JsonObject);
            if (themeId is null || !IdPattern().IsMatch(themeId) || colors.Count == 0)
            {
                return "Each theme needs an \"id\" and \"colors\" (#rrggbb or rgb()/rgba() values for xterm's colour names).";
            }
            themes.Add(new JsonObject
            {
                [Keys.Id] = $"{id}/{themeId}",
                [Keys.Name] = Text(theme, Keys.Name) ?? themeId,
                [Keys.Light] = theme[Keys.Light] is JsonValue light && light.TryGetValue<bool>(out var isLight) && isLight,
                [Keys.Colors] = colors,
            });
        }
        return null;
    }

    /// <summary>The colours given for xterm's colour names, each checked to be a colour.</summary>
    private static JsonObject Colors(JsonObject? given)
    {
        var colors = new JsonObject();
        foreach (var key in ColorKeys)
        {
            if (given is not null && Text(given, key) is { } color && ColorPattern().IsMatch(color))
            {
                colors[key] = color;
            }
        }
        return colors;
    }

    /// <summary>The plugin's script ("main"), which must be in its folder and not too large; null without one.</summary>
    private static string? ReadScript(JsonObject manifest, string folder, out string? script)
    {
        script = null;
        if (Text(manifest, Keys.Main) is not { } main)
        {
            return null;
        }
        var scriptPath = Path.GetFullPath(Path.Combine(folder, main));
        if (!scriptPath.StartsWith(Path.GetFullPath(folder) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(scriptPath))
        {
            return $"Its script \"{main}\" isn't in the plugin's folder.";
        }
        if (new FileInfo(scriptPath).Length > MaxScriptBytes)
        {
            return $"Its script is larger than {MaxScriptBytes / 1024} KB.";
        }
        script = File.ReadAllText(scriptPath);
        return null;
    }

    private static string? Text(JsonObject o, string key) =>
        o[key] is JsonValue value && value.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s) ? s.Trim() : null;

    [GeneratedRegex(@"^[a-z0-9][a-z0-9.-]{0,63}$")]
    private static partial Regex IdPattern();

    [GeneratedRegex(@"^(#[0-9a-fA-F]{3,8}|rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\))$")]
    private static partial Regex ColorPattern();
}
