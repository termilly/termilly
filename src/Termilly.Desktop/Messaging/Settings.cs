using System.Text.Json;

namespace Termilly.Desktop.Messaging;

// Settings, profiles, fonts, plugins and the update notice; workspaces, snapshots and history, which the page keeps
// and the host stores.

internal static partial class FromPage
{
    internal sealed record SettingsLoad : IPageMessage
    {
        public static string Type => "settings:load";
    }

    /// <summary>One group of Settings as the page has it now (AppSettings' group names: "terminal", "changes"…).</summary>
    internal sealed record SettingsSave(string Group, JsonElement Values) : IPageMessage
    {
        public static string Type => "settings:save";
    }

    internal sealed record ProfilesRefresh : IPageMessage
    {
        public static string Type => "profiles:refresh";
    }

    internal sealed record PluginsList : IPageMessage
    {
        public static string Type => "plugins:list";
    }

    internal sealed record PluginsOpen : IPageMessage
    {
        public static string Type => "plugins:open";
    }

    internal sealed record CheckForUpdates : IPageMessage
    {
        public static string Type => "update:check";
    }

    internal sealed record AskUpdateStatus : IPageMessage
    {
        public static string Type => "update:status";
    }

    /// <summary>The user chose "Download and install": download the newer version's installer.</summary>
    internal sealed record DownloadUpdate : IPageMessage
    {
        public static string Type => "update:download";
    }

    internal sealed record CancelUpdate : IPageMessage
    {
        public static string Type => "update:cancel";
    }

    /// <summary>The user chose "Restart to update": run the downloaded installer, and close.</summary>
    internal sealed record InstallUpdate : IPageMessage
    {
        public static string Type => "update:install";
    }

    /// <summary>The workspaces, as js/store.js serializes them.</summary>
    internal sealed record StateSave(JsonElement State = default) : IPageMessage
    {
        public static string Type => "state:save";
    }

    /// <param name="Final">The last one before the window closes (it asked with snapshot:request).</param>
    internal sealed record SnapshotSave(JsonElement Snapshot = default, bool Final = false) : IPageMessage
    {
        public static string Type => "snapshot:save";
    }

    /// <summary>A closed terminal, for history (HistoryStore).</summary>
    internal sealed record HistoryAdd(JsonElement Entry = default) : IPageMessage
    {
        public static string Type => "history:add";
    }

    internal sealed record HistoryList : IPageMessage
    {
        public static string Type => "history:list";
    }

    /// <summary>A command that finished, for command history (CommandHistory).</summary>
    internal sealed record HistoryCommand(JsonElement Entry = default) : IPageMessage
    {
        public static string Type => "history:command";
    }

    internal sealed record HistoryCommands : IPageMessage
    {
        public static string Type => "history:commands";
    }

    /// <param name="Id">The history entry.</param>
    internal sealed record HistoryDelete(string Id = "") : IPageMessage
    {
        public static string Type => "history:delete";
    }

    internal sealed record HistoryClear : IPageMessage
    {
        public static string Type => "history:clear";
    }
}

internal static partial class ToPage
{
    /// <summary>What boots the page: settings, profiles, saved workspaces, the last snapshot and more.</summary>
    internal sealed record Boot(
        AppSettings Settings, object Profiles, JsonElement? Workspaces, JsonElement? Snapshot, string[] LiveSessions,
        SecurityInfo Security, AboutInfo About) : IHostMessage
    {
        public static string Type => "settings";
    }

    /// <param name="NewRecoveryCode">Only for a key created in this run: the page asks the user to save it once.</param>
    internal sealed record SecurityInfo(string? NewRecoveryCode, int Archives);

    /// <param name="RemoteVersion">The servers' shell integration this Termilly brings (js/remotehost.js offers to update older ones).</param>
    /// <param name="Crashes">The crash logs written to lately, so a user can find one for a bug report.</param>
    internal sealed record AboutInfo(string? Version, string DataDir, int RemoteVersion, IReadOnlyList<RecentCrash> Crashes);

    internal sealed record Fonts(
        [property: System.Text.Json.Serialization.JsonPropertyName("fonts")] IReadOnlyList<string> Monospace,
        IReadOnlyList<string> UiFonts, IReadOnlyList<string> BoldFonts) : IHostMessage
    {
        public static string Type => "fonts";
    }

    /// <summary>What the page needs to list and badge profiles (not their command lines or variables).</summary>
    internal sealed record ProfileList(IEnumerable<ProfileSummary> Profiles) : IHostMessage
    {
        public static string Type => "profiles";
    }

    internal sealed record ProfileSummary(string Id, string Name, string? Description, string Icon, string Source, IReadOnlyList<string> Tags);

    internal sealed record PluginList(object Plugins) : IHostMessage
    {
        public static string Type => "plugins";
    }

    internal sealed record UpdateChecking : IHostMessage
    {
        public static string Type => "update:status";

        public bool Checking { get; } = true;
    }

    /// <param name="CheckedAt">When it last looked, in ms since 1970; null before the first check.</param>
    /// <param name="Progress">The update the user asked for: downloading, ready to install, installing or failed; null before.</param>
    internal sealed record UpdateStatus(string Current, long? CheckedAt, bool Failed, UpdateAvailable? Available, UpdateProgress? Progress) : IHostMessage
    {
        public static string Type => "update:status";
    }

    /// <param name="Installable">Whether this system's installer is in the manifest with its SHA-256, so it can be downloaded and installed.</param>
    /// <param name="EndsShells">Whether restarting to update ends the terminals' shells (they start again after).</param>
    internal sealed record UpdateAvailable(string Version, string? Date, string? Notes, bool Installable, bool EndsShells, bool Linux);

    /// <param name="State">One of <see cref="UpdateStates"/>.</param>
    /// <param name="Percent">How much is downloaded, 0 to 100.</param>
    /// <param name="Message">Why it failed, for the user.</param>
    /// <param name="Command">What to run to install it by hand (Linux without a password prompt).</param>
    internal sealed record UpdateProgress(string State, int Percent, string? Message, string? Command);

    internal sealed record History(object Entries) : IHostMessage
    {
        public static string Type => "history";
    }

    internal sealed record CommandList(JsonElement Entries) : IHostMessage
    {
        public static string Type => "history:commands";
    }
}
