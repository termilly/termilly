using System.Text.Json;

namespace Termilly.Desktop;

/// <summary>
/// User preferences, in groups (SettingGroups.cs), persisted as plain JSON under %LOCALAPPDATA%\Termilly (SettingsFile);
/// workspaces and history are encrypted separately. Custom profiles' variables are stored here too, so Settings warns
/// against putting secrets in them. The page edits one group at a time (settings:save with the group's name).
/// </summary>
internal sealed record AppSettings
{
    /// <summary>The file's shape: 2 is grouped; a file without a version is the flat one before it (SettingsMigration).</summary>
    public const int CurrentVersion = 2;

    /// <summary>What the file and the page use: camelCase names.</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    public int Version { get; init; } = CurrentVersion;
    /// <summary>How terminals look and behave.</summary>
    public TerminalSettings Terminal { get; init; } = new();
    /// <summary>The app around the terminals.</summary>
    public InterfaceSettings Interface { get; init; } = new();
    /// <summary>The shells on offer.</summary>
    public ShellSettings Shells { get; init; } = new();
    /// <summary>Snippets and triggers.</summary>
    public CommandSettings Commands { get; init; } = new();
    /// <summary>When a terminal's agent tells the user.</summary>
    public NotificationSettings Notifications { get; init; } = new();
    /// <summary>The drop-down window.</summary>
    public QuakeSettings Quake { get; init; } = new();
    /// <summary>What's kept between runs.</summary>
    public SessionSettings Session { get; init; } = new();
    /// <summary>Production safety and the paste warning.</summary>
    public SafetySettings Safety { get; init; } = new();
    /// <summary>Terminal logs.</summary>
    public LoggingSettings Logging { get; init; } = new();
    /// <summary>Recordings.</summary>
    public RecordingSettings Recording { get; init; } = new();
    /// <summary>SSH connections and forwards.</summary>
    public SshSettings Ssh { get; init; } = new();
    /// <summary>Coding agents.</summary>
    public AgentSettings Agents { get; init; } = new();
    /// <summary>The change preview.</summary>
    public ChangeSettings Changes { get; init; } = new();
    /// <summary>The AI assistant.</summary>
    public AiSettings Ai { get; init; } = new();
    /// <summary>Phone check-in.</summary>
    public CheckinSettings Checkin { get; init; } = new();
    /// <summary>Termilly on servers.</summary>
    public RemoteSettings Remote { get; init; } = new();
    /// <summary>What the page remembers.</summary>
    public UiState UiState { get; init; } = new();
    /// <summary>Data the page keeps here.</summary>
    public SettingsData Data { get; init; } = new();

    /// <summary>Every group checked: values that aren't a setting's own become its default, lists are cleaned.</summary>
    public AppSettings Normalize() => this with
    {
        Version = CurrentVersion,
        Terminal = (Terminal ?? new()).Normalize(),
        Interface = (Interface ?? new()).Normalize(),
        Shells = (Shells ?? new()).Normalize(),
        Commands = (Commands ?? new()).Normalize(),
        Notifications = (Notifications ?? new()).Normalize(),
        Quake = (Quake ?? new()).Normalize(),
        Session = (Session ?? new()).Normalize(),
        Safety = (Safety ?? new()).Normalize(),
        Logging = (Logging ?? new()).Normalize(),
        Recording = (Recording ?? new()).Normalize(),
        Ssh = (Ssh ?? new()).Normalize(),
        Agents = (Agents ?? new()).Normalize(),
        Changes = (Changes ?? new()).Normalize(),
        Ai = (Ai ?? new()).Normalize(),
        Checkin = (Checkin ?? new()).Normalize(),
        Remote = (Remote ?? new()).Normalize(),
        UiState = (UiState ?? new()).Normalize(),
        Data = (Data ?? new()).Normalize(),
    };

    /// <summary>A group's name in the file and on the wire ("terminal", "uiState").</summary>
    public static string GroupName(string property) => JsonNamingPolicy.CamelCase.ConvertName(property);

    /// <summary>
    /// These settings with one group replaced by what the page sent, checked; unchanged for a group that isn't one.
    /// JsonException when the values don't read as the group.
    /// </summary>
    public AppSettings WithGroup(string group, JsonElement values) =>
        Setters.TryGetValue(group, out var with) ? with(this, values).Normalize() : this;

    private static readonly Dictionary<string, Func<AppSettings, JsonElement, AppSettings>> Setters = new(StringComparer.Ordinal)
    {
        [GroupName(nameof(Terminal))] = (s, v) => s with { Terminal = Read<TerminalSettings>(v) },
        [GroupName(nameof(Interface))] = (s, v) => s with { Interface = Read<InterfaceSettings>(v) },
        [GroupName(nameof(Shells))] = (s, v) => s with { Shells = Read<ShellSettings>(v) },
        [GroupName(nameof(Commands))] = (s, v) => s with { Commands = Read<CommandSettings>(v) },
        [GroupName(nameof(Notifications))] = (s, v) => s with { Notifications = Read<NotificationSettings>(v) },
        [GroupName(nameof(Quake))] = (s, v) => s with { Quake = Read<QuakeSettings>(v) },
        [GroupName(nameof(Session))] = (s, v) => s with { Session = Read<SessionSettings>(v) },
        [GroupName(nameof(Safety))] = (s, v) => s with { Safety = Read<SafetySettings>(v) },
        [GroupName(nameof(Logging))] = (s, v) => s with { Logging = Read<LoggingSettings>(v) },
        [GroupName(nameof(Recording))] = (s, v) => s with { Recording = Read<RecordingSettings>(v) },
        [GroupName(nameof(Ssh))] = (s, v) => s with { Ssh = Read<SshSettings>(v) },
        [GroupName(nameof(Agents))] = (s, v) => s with { Agents = Read<AgentSettings>(v) },
        [GroupName(nameof(Changes))] = (s, v) => s with { Changes = Read<ChangeSettings>(v) },
        [GroupName(nameof(Ai))] = (s, v) => s with { Ai = Read<AiSettings>(v) },
        [GroupName(nameof(Checkin))] = (s, v) => s with { Checkin = Read<CheckinSettings>(v) },
        [GroupName(nameof(Remote))] = (s, v) => s with { Remote = Read<RemoteSettings>(v) },
        [GroupName(nameof(UiState))] = (s, v) => s with { UiState = Read<UiState>(v) },
        [GroupName(nameof(Data))] = (s, v) => s with { Data = Read<SettingsData>(v) },
    };

    private static T Read<T>(JsonElement values) where T : new() => values.Deserialize<T>(Json) ?? new T();
}
