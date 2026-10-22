using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// settings.json in the data folder. A file in the old flat shape is moved into groups when it's read (the original
/// kept as settings.v1.json) and written back grouped.
/// </summary>
internal static class SettingsFile
{
    private const string FileName = "settings.json";
    /// <summary>The flat file as it was before it was moved into groups, kept once.</summary>
    private const string Version1Copy = "settings.v1.json";

    public static string DefaultPath => Path.Combine(AppPaths.DataDirectory, FileName);

    /// <summary>The settings in the file, checked; the defaults when there's none or it can't be read.</summary>
    public static AppSettings Load(string? path = null)
    {
        path ??= DefaultPath;
        try
        {
            if (!File.Exists(path) || JsonNode.Parse(File.ReadAllText(path)) is not JsonObject file)
            {
                return new();
            }
            if (!SettingsMigration.IsVersion1(file))
            {
                return (file.Deserialize<AppSettings>(AppSettings.Json) ?? new()).Normalize();
            }
            var copy = Path.Combine(Path.GetDirectoryName(path)!, Version1Copy);
            if (!File.Exists(copy))
            {
                File.Copy(path, copy);
            }
            var migrated = (SettingsMigration.ToVersion2(file).Deserialize<AppSettings>(AppSettings.Json) ?? new()).Normalize();
            Save(migrated, path);
            return migrated;
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            // Unreadable settings fall back to defaults rather than blocking startup.
            return new();
        }
    }

    /// <summary>
    /// Whether the file still names Anthropic as the provider of the AI assistant, which Termilly had until 1.1.0:
    /// the assistant's API key may then still be kept (RetiredAssistantKey removes it).
    /// </summary>
    public static bool NamesAnthropicAssistant(string? path = null)
    {
        path ??= DefaultPath;
        try
        {
            return File.Exists(path) && JsonNode.Parse(File.ReadAllText(path)) is JsonObject file
                && file[RetiredAssistant.Group]?[RetiredAssistant.Provider] is JsonValue provider
                && provider.TryGetValue<string>(out var name) && name == RetiredAssistant.Anthropic;
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException or InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>The AI assistant's group in files from 1.1.0 and before.</summary>
    private static class RetiredAssistant
    {
        public const string Group = "ai";
        public const string Provider = "provider";
        public const string Anthropic = "anthropic";
    }

    public static void Save(AppSettings settings, string? path = null)
    {
        path ??= DefaultPath;
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        AppPaths.WriteAtomically(path, JsonSerializer.Serialize(settings, AppSettings.Json));
    }
}
