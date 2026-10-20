using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;

namespace Termilly.Setup.Engine;

/// <summary>
/// What setup writes into Termilly's own settings.json (this user's), merged into what's there.
/// </summary>
/// <remarks>
/// settings.json is in groups (version 2, Termilly's Settings/AppSettings.cs); a file from before groups is flat,
/// and stays flat here: Termilly moves it into groups when it next starts. A new file is written in groups.
/// </remarks>
internal static class TermillySettings
{
    /// <summary>Sets one setting: its group and name, its name in a flat file, and the value.</summary>
    private delegate void Setter(string group, string key, string flatKey, bool value);

    /// <summary>
    /// Agent integration, background shells at sign-in and the tour. Termilly writes the sign-in entry itself when it
    /// starts.
    /// </summary>
    public static void Write(SetupOptions options)
    {
        Edit(create: true, (set, fresh) =>
        {
            set(SettingsFile.Agents, SettingsFile.Integration, SettingsFile.FlatAgentIntegration, options.AgentIntegration);
            if (options.BackgroundAtSignIn)
            {
                set(SettingsFile.Session, SettingsFile.BackgroundShells, SettingsFile.BackgroundShells, true);
                set(SettingsFile.Session, SettingsFile.BackgroundAtSignIn, SettingsFile.BackgroundAtSignIn, true);
            }
            else if (fresh)
            {
                set(SettingsFile.Session, SettingsFile.BackgroundAtSignIn, SettingsFile.BackgroundAtSignIn, false);
            }
            if (fresh || !options.Tour)
            {
                set(SettingsFile.UiState, SettingsFile.TourSeen, SettingsFile.TourSeen, !options.Tour);
            }
        });
        Log.Write($"Termilly settings: agent integration {(options.AgentIntegration ? "on" : "off")}, sign-in shells {(options.BackgroundAtSignIn ? "on" : "unchanged")}");
    }

    /// <summary>Whether Termilly offers its tour at first start (the Done page's box, changed after installing).</summary>
    public static void SetTourSeen(bool seen) =>
        Edit(create: false, (set, _) => set(SettingsFile.UiState, SettingsFile.TourSeen, SettingsFile.TourSeen, seen));

    /// <summary>
    /// Reads settings.json, lets <paramref name="change"/> set what it needs (with whether the file is new), and writes
    /// it back. A file that isn't readable JSON is left alone; with <paramref name="create"/> false, so is a missing one.
    /// </summary>
    private static void Edit(bool create, Action<Setter, bool> change)
    {
        var file = Path.Combine(Folders.Data, SettingsFile.Name);
        if (!create && !File.Exists(file))
        {
            return;
        }
        var json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };
        Dictionary<string, object> settings;
        try
        {
            settings = File.Exists(file) ? json.DeserializeObject(File.ReadAllText(file)) as Dictionary<string, object> ?? new() : new();
        }
        catch (ArgumentException)
        {
            Log.Write("settings.json isn't readable JSON; leaving it alone");
            return;
        }
        var fresh = settings.Count == 0;
        var flat = !fresh && !settings.ContainsKey(SettingsFile.Version);
        if (fresh)
        {
            settings[SettingsFile.Version] = SettingsFile.GroupedVersion;
        }
        change((group, key, flatKey, value) => SetSetting(settings, flat ? null : group, flat ? flatKey : key, value), fresh);
        Directory.CreateDirectory(Folders.Data);
        File.WriteAllText(file, json.Serialize(settings), new UTF8Encoding(false));
    }

    /// <summary>A setting in a group (version 2), or at the top level of a flat file (group null).</summary>
    private static void SetSetting(Dictionary<string, object> settings, string? group, string key, bool value)
    {
        if (group is null)
        {
            settings[key] = value;
        }
        else if (settings.TryGetValue(group, out var found) && found is Dictionary<string, object> values)
        {
            values[key] = value;
        }
        else
        {
            settings[group] = new Dictionary<string, object> { [key] = value };
        }
    }

    /// <summary>The names in Termilly's settings.json the installer writes (Termilly's Settings/SettingGroups.cs).</summary>
    private static class SettingsFile
    {
        public const string Name = "settings.json";
        public const string Version = "version";
        public const int GroupedVersion = 2;
        public const string Agents = "agents";
        public const string Integration = "integration";
        public const string Session = "session";
        public const string BackgroundShells = "backgroundShells";
        public const string BackgroundAtSignIn = "backgroundAtSignIn";
        public const string UiState = "uiState";
        public const string TourSeen = "tourSeen";
        /// <summary>Agent integration's name in a file from before groups.</summary>
        public const string FlatAgentIntegration = "agentIntegration";
    }
}
