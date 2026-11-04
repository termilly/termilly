namespace Termilly.Desktop;

// The groups of AppSettings, each with its defaults and its own check of what it was given (Normalize). A value
// that isn't one of a setting's own (SettingValues) becomes its default; lists are cleaned and capped.

/// <summary>How terminals look and behave: font, cursor, scrollback, images, the clipboard, colours, ports.</summary>
internal sealed record TerminalSettings
{
    public const string DefaultFont = "Consolas";
    public const double DefaultFontSize = 14;
    public const double MinFontSize = 8;
    public const double MaxFontSize = 32;
    public const double DefaultLineHeight = 1.2;
    private const double MinLineHeight = 1.0;
    private const double MaxLineHeight = 2.0;
    private const int LineHeightDigits = 1;
    public const int DefaultScrollback = 10_000;
    private const int MinScrollback = 1_000;
    public const int MaxScrollback = 50_000;

    public string FontFamily { get; init; } = DefaultFont;
    public double FontSize { get; init; } = DefaultFontSize;
    public string CursorStyle { get; init; } = SettingValues.CursorStyle.Default;
    public bool CursorBlink { get; init; } = true;
    public double LineHeight { get; init; } = DefaultLineHeight;
    public int Scrollback { get; init; } = DefaultScrollback;
    public string TextSmoothing { get; init; } = SettingValues.TextSmoothing.Default;
    /// <summary>Terminals drawn on the GPU (xterm's WebGL add-on, js/gpu.js): smoother scrolling; text is greyscale-smoothed then.</summary>
    public bool GpuRendering { get; init; } = true;
    /// <summary>Images programs print (sixel, iTerm2's), shown inline.</summary>
    public bool InlineImages { get; init; } = true;
    /// <summary>Programs may set the clipboard (OSC 52).</summary>
    public bool ProgramClipboard { get; init; } = true;
    /// <summary>Selecting text in a terminal copies it.</summary>
    public bool CopyOnSelect { get; init; }
    /// <summary>What opens a web address in a terminal’s output (js/weblinks.js): Ctrl+click, or a plain click.</summary>
    public string LinkClick { get; init; } = SettingValues.LinkClick.Default;
    /// <summary>The terminal colour scheme's id (js/themes.js); null: the theme's own.</summary>
    public string? Colors { get; init; }
    /// <summary>A terminal's row shows the ports its programs listen on.</summary>
    public bool Ports { get; init; } = true;

    public TerminalSettings Normalize() => this with
    {
        FontFamily = string.IsNullOrWhiteSpace(FontFamily) ? DefaultFont : FontFamily.Trim(),
        FontSize = Math.Clamp(Math.Round(FontSize), MinFontSize, MaxFontSize),
        CursorStyle = SettingChecks.OneOf(CursorStyle, SettingValues.CursorStyle.All, SettingValues.CursorStyle.Default),
        LineHeight = Math.Clamp(Math.Round(LineHeight, LineHeightDigits), MinLineHeight, MaxLineHeight),
        Scrollback = Math.Clamp(Scrollback, MinScrollback, MaxScrollback),
        TextSmoothing = SettingChecks.OneOf(TextSmoothing, SettingValues.TextSmoothing.All, SettingValues.TextSmoothing.Default),
        LinkClick = SettingChecks.OneOf(LinkClick, SettingValues.LinkClick.All, SettingValues.LinkClick.Default),
        Colors = SettingChecks.Trimmed(Colors),
    };
}

/// <summary>The app around the terminals: theme, its own font, the sidebar's activity and git status, updates, plugins.</summary>
internal sealed record InterfaceSettings
{
    private const int MaxDisabledPlugins = 100;
    /// <summary>The most shortcuts with keys of their own, and the longest id or keys one may have.</summary>
    private const int MaxShortcuts = 100;
    private const int MaxShortcutText = 40;
    /// <summary>The longest theme id js/themes.js uses.</summary>
    private const int MaxThemeId = 40;

    public string Theme { get; init; } = SettingValues.Theme.Default;
    /// <summary>The app's font; null: the system's.</summary>
    public string? Font { get; init; }
    public bool ShowActivity { get; init; } = true;
    public bool ConfirmCloseWorkspace { get; init; } = true;
    public bool GitStatus { get; init; } = true;
    public bool CheckForUpdates { get; init; } = true;
    public IReadOnlyList<string>? DisabledPlugins { get; init; }
    /// <summary>The window's Minimize: to the taskbar, or the tray (Windows).</summary>
    public string MinimizeTo { get; init; } = SettingValues.MinimizeTo.Default;
    /// <summary>The window's Close: quit, or keep running in the tray (Windows).</summary>
    public string CloseAction { get; init; } = SettingValues.CloseAction.Default;
    /// <summary>Quitting asks first while a command or an agent is still running (unless shells are kept running).</summary>
    public bool ConfirmQuit { get; init; } = true;
    /// <summary>
    /// Linux on Wayland: Termilly runs as an X11 app (XWayland), as VS Code does, so it may place its windows (a
    /// terminal dragged out opens where it's let go). From the next start.
    /// </summary>
    public bool RunAsX11 { get; init; } = true;
    /// <summary>
    /// The whole app's size, in percent (Ctrl+Shift+= and -): its text, icons and terminals together, in every window.
    /// </summary>
    public int Zoom { get; init; } = DefaultZoom;

    public const int DefaultZoom = 100;
    private const int MinZoom = 50;
    private const int MaxZoom = 200;
    /// <summary>
    /// Termilly's shortcuts with keys of the user's own (js/keymap.js, Settings › Keyboard): a shortcut's id to its keys
    /// ("Ctrl+Shift+T"), "" for none. One not here has its default.
    /// </summary>
    public IReadOnlyDictionary<string, string>? Shortcuts { get; init; }

    public InterfaceSettings Normalize() => this with
    {
        Theme = IsThemeId(Theme) ? Theme : SettingValues.Theme.Default,
        MinimizeTo = SettingChecks.OneOf(MinimizeTo, SettingValues.MinimizeTo.All, SettingValues.MinimizeTo.Default),
        CloseAction = SettingChecks.OneOf(CloseAction, SettingValues.CloseAction.All, SettingValues.CloseAction.Default),
        Font = SettingChecks.Trimmed(Font),
        Zoom = Math.Clamp(Zoom, MinZoom, MaxZoom),
        DisabledPlugins = (DisabledPlugins ?? []).Where(id => !string.IsNullOrWhiteSpace(id)).Distinct().Take(MaxDisabledPlugins).ToList(),
        Shortcuts = (Shortcuts ?? new Dictionary<string, string>())
            .Where(s => s.Key.Length is > 0 and <= MaxShortcutText && (s.Value ?? "").Length <= MaxShortcutText)
            .Take(MaxShortcuts).ToDictionary(s => s.Key, s => s.Value ?? ""),
    };

    /// <summary>A theme's id as js/themes.js has them: lowercase letters, digits and hyphens.</summary>
    private static bool IsThemeId(string? id) =>
        id is { Length: > 0 and <= MaxThemeId } && id.All(c => c is >= 'a' and <= 'z' or >= '0' and <= '9' or '-');
}

/// <summary>The shells on offer: the default, the user's own profiles and notes, shell integration, COM ports and consoles.</summary>
internal sealed record ShellSettings
{
    public const int MaxProfiles = 50;
    private const int MaxSerialPorts = 64;
    private const int MaxNetworkConsoles = 64;
    private const int MaxTags = 8;
    private const int MaxPort = 65535;

    /// <summary>The profile new terminals start with; null: the first one.</summary>
    public string? DefaultProfile { get; init; }
    public IReadOnlyList<CustomProfile>? Profiles { get; init; }
    /// <summary>A note per profile id, pinned to its terminals' headers.</summary>
    public IReadOnlyDictionary<string, string>? Notes { get; init; }
    /// <summary>Shell integration: detected shells mark their prompts and commands.</summary>
    public bool Integration { get; init; } = true;
    /// <summary>Docker containers and Kubernetes pods offered as profiles.</summary>
    public bool DynamicSources { get; init; } = true;
    public IReadOnlyList<SerialSettings>? SerialPorts { get; init; }
    public IReadOnlyList<NetworkConsole>? NetworkConsoles { get; init; }

    public ShellSettings Normalize() => this with
    {
        Profiles = NormalizeProfiles(Profiles),
        SerialPorts = (SerialPorts ?? []).Where(p => p.Port?.StartsWith(Desktop.SerialPorts.ComPrefix, StringComparison.OrdinalIgnoreCase) == true)
            .DistinctBy(p => p.Port.ToUpperInvariant()).Select(Desktop.SerialPorts.Normalize).Take(MaxSerialPorts).ToList(),
        NetworkConsoles = (NetworkConsoles ?? [])
            .Where(c => !string.IsNullOrWhiteSpace(c.Id) && !string.IsNullOrWhiteSpace(c.Name) && Desktop.SshConnections.IsSafe(c.Host) && c.Host.Length > 0 && c.Port is > 0 and <= MaxPort)
            .DistinctBy(c => c.Id)
            .Select(Desktop.SerialPorts.Normalize)
            .Take(MaxNetworkConsoles).ToList(),
    };

    /// <summary>Drops profiles without a name or command, and repeated ids; trims the rest.</summary>
    private static List<CustomProfile> NormalizeProfiles(IReadOnlyList<CustomProfile>? profiles)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return (profiles ?? [])
            .Where(p => !string.IsNullOrWhiteSpace(p.Name) && !string.IsNullOrWhiteSpace(p.CommandLine) &&
                        !string.IsNullOrWhiteSpace(p.Id) && ids.Add(p.Id))
            .Take(MaxProfiles)
            .Select(p => p with
            {
                Name = p.Name.Trim(),
                CommandLine = p.CommandLine.Trim(),
                WorkingDirectory = SettingChecks.Trimmed(p.WorkingDirectory),
                Environment = p.Environment?
                    .Where(kv => SettingChecks.IsVariableName(kv.Key.Trim()))
                    .GroupBy(kv => kv.Key.Trim(), StringComparer.OrdinalIgnoreCase)
                    .ToDictionary(g => g.Key, g => g.Last().Value ?? "", StringComparer.OrdinalIgnoreCase),
                Tags = p.Tags?.Select(t => t.Trim()).Where(t => t.Length > 0).Distinct().Take(MaxTags).ToList(),
                Icon = SettingChecks.OneOf(p.Icon, SettingValues.ProfileIcon.All, SettingValues.ProfileIcon.Default),
            })
            .ToList();
    }
}

/// <summary>The user's saved commands (snippets) and the patterns watched in the output (triggers).</summary>
internal sealed record CommandSettings
{
    public const int MaxTriggers = 40;
    /// <summary>The longest trigger pattern kept.</summary>
    private const int MaxPattern = 300;

    public IReadOnlyList<SnippetSetting>? Snippets { get; init; }
    public IReadOnlyList<TriggerSetting>? Triggers { get; init; }
    /// <summary>Web pages and programs to start (Actions.cs); Termilly’s own until the user changes them.</summary>
    public IReadOnlyList<ActionSetting>? Actions { get; init; }

    public CommandSettings Normalize() => this with { Triggers = NormalizeTriggers(Triggers), Actions = NormalizeActions(Actions) };

    /// <summary>Drops actions without a name or target or with a repeated id; none saved yet means the defaults.</summary>
    private static List<ActionSetting> NormalizeActions(IReadOnlyList<ActionSetting>? actions)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return (actions ?? Termilly.Desktop.Actions.Defaults)
            .Where(a => !string.IsNullOrWhiteSpace(a.Id) && !string.IsNullOrWhiteSpace(a.Name) && !string.IsNullOrWhiteSpace(a.Target) && ids.Add(a.Id))
            .Take(Termilly.Desktop.Actions.MaxActions)
            .Select(a => a with
            {
                Name = a.Name.Trim(),
                Target = a.Target.Trim(),
                Arguments = SettingChecks.Trimmed(a.Arguments),
                Shortcut = SettingChecks.Trimmed(a.Shortcut),
            })
            .ToList();
    }

    /// <summary>Drops triggers without a pattern or with a repeated id, caps the pattern, and fixes odd values.</summary>
    private static List<TriggerSetting> NormalizeTriggers(IReadOnlyList<TriggerSetting>? triggers)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return (triggers ?? [])
            .Where(t => !string.IsNullOrWhiteSpace(t.Pattern) && !string.IsNullOrWhiteSpace(t.Id) && ids.Add(t.Id))
            .Take(MaxTriggers)
            .Select(t => t with
            {
                Pattern = t.Pattern.Length > MaxPattern ? t.Pattern[..MaxPattern] : t.Pattern,
                Action = SettingChecks.OneOf(t.Action, SettingValues.TriggerAction.All, SettingValues.TriggerAction.Default),
                Scope = SettingValues.TriggerScope.IsValid(t.Scope) ? t.Scope : SettingValues.TriggerScope.Default,
                Name = SettingChecks.Trimmed(t.Name),
                Color = SettingChecks.HasColourShape(t.Color) ? t.Color : null,
            })
            .ToList();
    }
}

/// <summary>When a terminal's agent tells the user, and the system-wide "next terminal that needs me" shortcut.</summary>
/// <summary>
/// Clipboard (Clipboard.cs): every copy kept, text and images, to paste any of them later. Copies made in other apps
/// are kept too where the system tells about them (Windows); kept after a restart encrypted with the vault.
/// </summary>
internal sealed record ClipSettings
{
    /// <summary>Copies are kept; off, Clipboard only shows what it already has.</summary>
    public bool Enabled { get; init; } = true;
    /// <summary>Copies made in other apps are kept too, not only Termilly's.</summary>
    public bool OtherApps { get; init; } = true;
    /// <summary>Clips are kept after a restart (encrypted); off, they last until Termilly closes.</summary>
    public bool Keep { get; init; } = true;
    /// <summary>The most clips kept that aren't pinned.</summary>
    public int Limit { get; init; } = SettingValues.ClipLimit.Default;

    public ClipSettings Normalize() => this with { Limit = Math.Clamp(Limit, SettingValues.ClipLimit.Min, SettingValues.ClipLimit.Max) };
}

/// <summary>
/// Termilly on a phone (Phone/PhoneServer.cs, docs/phone.md): off by default; while on, a server on this PC's local
/// network address serves the phone app to paired phones over HTTPS.
/// </summary>
internal sealed record PhoneSettings
{
    public const int DefaultPort = 8765;
    /// <summary>The ports a user may pick: the unprivileged ones.</summary>
    public const int MinPort = 1024;
    public const int MaxPort = 65535;

    public bool Enabled { get; init; }
    public int Port { get; init; } = DefaultPort;
    /// <summary>When an agent's news goes to the phones that take alerts (SettingValues.PhoneAlerts).</summary>
    public string Alerts { get; init; } = SettingValues.PhoneAlerts.Always;
    /// <summary>Alerts say only that an agent needs the user or finished: no terminal, workspace or message.</summary>
    public bool HideDetails { get; init; }
    /// <summary>A paired phone may type into a terminal it shows (answers to an agent are always allowed).</summary>
    public bool AllowTyping { get; init; }
    /// <summary>
    /// While typing is allowed, a phone may paste Clipboard's text clips: it gets their first lines (secrets masked) and
    /// asks the PC to paste one, so a clip's text never goes to the phone.
    /// </summary>
    public bool Clips { get; init; } = true;
    /// <summary>A paired computer may open Prompt history for a terminal of this PC it shows (Phone/PcPromptsApi.cs).</summary>
    public bool SharePrompts { get; init; } = true;
    /// <summary>How another computer's terminal opened here is drawn (SettingValues.PcSize).</summary>
    public string PcSize { get; init; } = SettingValues.PcSize.Default;

    public PhoneSettings Normalize() => this with
    {
        Port = Port is >= MinPort and <= MaxPort ? Port : DefaultPort,
        Alerts = SettingChecks.OneOf(Alerts, SettingValues.PhoneAlerts.All, SettingValues.PhoneAlerts.Always),
        PcSize = SettingChecks.OneOf(PcSize, SettingValues.PcSize.All, SettingValues.PcSize.Default),
    };
}

internal sealed record NotificationSettings
{
    public bool NeedsInput { get; init; } = true;
    public bool Error { get; init; } = true;
    public bool Done { get; init; } = true;
    public bool JumpHotkey { get; init; }
    /// <summary>The sound (wwwroot/sounds, js/sounds.js) when an agent needs the user or wants attention; Off by choosing none.</summary>
    public string SoundNeedsInput { get; init; } = SettingValues.Sound.Ping1;
    public string SoundError { get; init; } = SettingValues.Sound.None;
    public string SoundDone { get; init; } = SettingValues.Sound.None;
    /// <summary>When quitting asks first, because something is still running.</summary>
    public string SoundQuit { get; init; } = SettingValues.Sound.None;
    public int SoundVolume { get; init; } = SettingValues.SoundVolume.Default;
    /// <summary>The output the sounds play on (an id from <see cref="Platform.IAudioOutputs"/>); null for the system’s default.</summary>
    public string? SoundDevice { get; init; }

    public NotificationSettings Normalize() => this with
    {
        SoundNeedsInput = SettingChecks.OneOf(SoundNeedsInput, SettingValues.Sound.All, SettingValues.Sound.Ping1),
        SoundError = SettingChecks.OneOf(SoundError, SettingValues.Sound.All, SettingValues.Sound.None),
        SoundDone = SettingChecks.OneOf(SoundDone, SettingValues.Sound.All, SettingValues.Sound.None),
        SoundQuit = SettingChecks.OneOf(SoundQuit, SettingValues.Sound.All, SettingValues.Sound.None),
        SoundVolume = Math.Clamp(SoundVolume, SettingValues.SoundVolume.Min, SettingValues.SoundVolume.Max),
        SoundDevice = SettingChecks.Trimmed(SoundDevice),
    };
}

/// <summary>What's kept between runs: the restore at start, history, hidden terminals' scrollback, background shells.</summary>
internal sealed record SessionSettings
{
    public string Restore { get; init; } = SettingValues.RestoreSession.Default;
    public int HistoryDays { get; init; } = SettingValues.HistoryDays.Default;
    /// <summary>Termilly says when history passes <see cref="HistoryWarnGb"/>.</summary>
    public bool HistoryWarn { get; init; } = true;
    public int HistoryWarnGb { get; init; } = SettingValues.HistoryWarnGb.Default;
    public int HiddenScrollback { get; init; } = SettingValues.HiddenScrollback.Default;
    /// <summary>Closed terminals' output is kept in the history.</summary>
    public bool SaveOutput { get; init; } = true;
    /// <summary>Secrets are redacted from what's kept.</summary>
    public bool RedactSecrets { get; init; }
    /// <summary>Shells keep running in the background host after the window closes.</summary>
    public bool BackgroundShells { get; init; }
    public bool BackgroundAtSignIn { get; init; }

    public SessionSettings Normalize() => this with
    {
        Restore = SettingChecks.OneOf(Restore, SettingValues.RestoreSession.All, SettingValues.RestoreSession.Default),
        HistoryDays = HistoryDays < 0 ? SettingValues.HistoryDays.Default : Math.Min(HistoryDays, SettingValues.HistoryDays.Max),
        HistoryWarnGb = Math.Clamp(HistoryWarnGb, SettingValues.HistoryWarnGb.Min, SettingValues.HistoryWarnGb.Max),
        HiddenScrollback = SettingChecks.OneOf(HiddenScrollback, SettingValues.HiddenScrollback.All, SettingValues.HiddenScrollback.Default),
    };
}

/// <summary>Production safety: the environments terminals can be on, pasting into them, and the paste warning.</summary>
internal sealed record SafetySettings
{
    public IReadOnlyList<EnvironmentSetting>? Environments { get; init; }
    public string ProdPaste { get; init; } = SettingValues.ProdPaste.Default;
    public bool ProdTint { get; init; }
    public bool PasteWarning { get; init; } = true;
    /// <summary>The terminals (profile ids) the paste warning is off for.</summary>
    public IReadOnlyList<string>? PasteWarningOff { get; init; }

    public SafetySettings Normalize() => this;
}

/// <summary>Terminal logs: where, in which format, with timestamps, redacted, for how long, for which terminals.</summary>
internal sealed record LoggingSettings
{
    /// <summary>Null: Documents\Termilly\logs.</summary>
    public string? Folder { get; init; }
    public string Format { get; init; } = SettingValues.LogFormat.Default;
    public bool Timestamps { get; init; }
    public bool Redact { get; init; } = true;
    /// <summary>0: logs are kept.</summary>
    public int KeepDays { get; init; }
    /// <summary>Terminals with these tags, or of these profiles, are logged from the start.</summary>
    public IReadOnlyList<string>? Tags { get; init; }
    public IReadOnlyList<string>? Profiles { get; init; }

    public LoggingSettings Normalize() => this;
}

/// <summary>Recordings (asciicast): where, redacted, agents' terminals recorded too, and the size they stop at.</summary>
internal sealed record RecordingSettings
{
    public const int DefaultMaxMb = 100;

    /// <summary>Null: Documents\Termilly\recordings.</summary>
    public string? Folder { get; init; }
    public bool Redact { get; init; } = true;
    public bool Agents { get; init; }
    public int MaxMb { get; init; } = DefaultMaxMb;

    public RecordingSettings Normalize() => this;
}

/// <summary>SSH: keepalives, reconnecting, tmux on each host, the connections and port forwards defined in Settings.</summary>
internal sealed record SshSettings
{
    public bool KeepAlive { get; init; } = true;
    public bool Reconnect { get; init; } = true;
    /// <summary>A host's tmux session to attach to, by profile id.</summary>
    public IReadOnlyDictionary<string, string>? Attach { get; init; }
    public IReadOnlyList<SshConnection>? Connections { get; init; }
    public IReadOnlyList<PortForward>? Forwards { get; init; }

    public SshSettings Normalize() => this with
    {
        Connections = Desktop.SshConnections.Normalize(Connections),
        Forwards = Desktop.SshConnections.Normalize(Forwards),
    };
}

/// <summary>Coding agents: the hooks, how many run before idle ones hibernate, reading terminals, the API, cost and usage.</summary>
internal sealed record AgentSettings
{
    /// <summary>Agent integration: Claude Code's hooks in Termilly's terminals.</summary>
    public bool Integration { get; init; } = true;
    public int Limit { get; init; } = SettingValues.AgentLimit.Default;
    /// <summary>A terminal lets agents read it unless it's SSH, production or sensitive.</summary>
    public bool ReadDefault { get; init; } = true;
    /// <summary>Scripts and agents may type into terminals (Settings › Terminal › API).</summary>
    public bool ApiAllowInput { get; init; }
    /// <summary>The sidebar's agent activity line.</summary>
    public string Line { get; init; } = SettingValues.AgentLine.Default;
    public string CostDisplay { get; init; } = SettingValues.CostDisplay.Default;
    public bool ClaudeUsage { get; init; } = true;
    public bool ClaudeLimits { get; init; } = true;

    public AgentSettings Normalize() => this with
    {
        Limit = SettingChecks.OneOf(Limit, SettingValues.AgentLimit.All, SettingValues.AgentLimit.Default),
    };
}

/// <summary>The change preview (Changes/, js/preview.js): where it opens, what it compares, and how it shows a change.</summary>
internal sealed record ChangeSettings
{
    public bool Enabled { get; init; } = true;
    public string Placement { get; init; } = SettingValues.ChangePlacement.Default;
    /// <summary>File paths in a terminal open the preview (Ctrl+click).</summary>
    public bool Links { get; init; } = true;
    public bool Button { get; init; } = true;
    public bool Shortcut { get; init; } = true;
    public string Source { get; init; } = SettingValues.ChangeSource.Default;
    public string Compare { get; init; } = SettingValues.ChangeCompare.Default;
    public string Keep { get; init; } = SettingValues.ChangeKeep.Default;
    public int Context { get; init; } = SettingValues.ChangeContext.Default;
    public bool Highlight { get; init; } = true;
    public bool Wrap { get; init; }
    public int MaxFileKb { get; init; } = SettingValues.ChangeMaxFileKb.Default;
    public string Layout { get; init; } = SettingValues.ChangeLayout.Default;
    public string Follow { get; init; } = SettingValues.ChangeFollow.Default;
    public string NewFile { get; init; } = SettingValues.ChangeNewFile.Default;
    /// <summary>Files a shell command made or changed are listed too.</summary>
    public bool ShellFiles { get; init; } = true;

    public ChangeSettings Normalize() => this with
    {
        Placement = SettingChecks.OneOf(Placement, SettingValues.ChangePlacement.All, SettingValues.ChangePlacement.Default),
        Source = SettingChecks.OneOf(Source, SettingValues.ChangeSource.All, SettingValues.ChangeSource.Default),
        Compare = SettingChecks.OneOf(Compare, SettingValues.ChangeCompare.All, SettingValues.ChangeCompare.Default),
        Keep = SettingChecks.OneOf(Keep, SettingValues.ChangeKeep.All, SettingValues.ChangeKeep.Default),
        Context = SettingChecks.OneOf(Context, SettingValues.ChangeContext.All, SettingValues.ChangeContext.Default),
        MaxFileKb = SettingChecks.OneOf(MaxFileKb, SettingValues.ChangeMaxFileKb.All, SettingValues.ChangeMaxFileKb.Default),
        Layout = SettingChecks.OneOf(Layout, SettingValues.ChangeLayout.All, SettingValues.ChangeLayout.Default),
        Follow = SettingChecks.OneOf(Follow, SettingValues.ChangeFollow.All, SettingValues.ChangeFollow.Default),
        NewFile = SettingChecks.OneOf(NewFile, SettingValues.ChangeNewFile.All, SettingValues.ChangeNewFile.Default),
    };
}

/// <summary>Termilly's integration on servers: whether each host has it set up (RemoteIntegration).</summary>
internal sealed record RemoteSettings
{
    /// <summary>The setup's state, by host profile id.</summary>
    public IReadOnlyDictionary<string, string>? Setup { get; init; }

    public RemoteSettings Normalize() => this;
}

/// <summary>What the page remembers rather than what the user sets: the tour, the Remote section, the window's colours.</summary>
internal sealed record UiState
{
    public bool TourSeen { get; init; }
    /// <summary>The sidebar's Remote section (js/remote.js): pinned hosts (profile ids).</summary>
    public IReadOnlyList<string>? RemotePinned { get; init; }
    /// <summary>When each host was last opened (ms).</summary>
    public IReadOnlyDictionary<string, long>? RemoteRecent { get; init; }
    /// <summary>The theme's window colours, saved by the page (js/themes.js) for the window and loader at start-up.</summary>
    public ThemeWindowColors? WindowColors { get; init; }
    public bool StopAgentConfirmed { get; init; }
    /// <summary>An update the user chose to skip.</summary>
    public string? SkippedVersion { get; init; }

    public UiState Normalize() => this with
    {
        WindowColors = WindowColors is { } colors && new[] { colors.Background, colors.Frame, colors.Text, colors.Accent }.All(SettingChecks.IsHexColour)
            ? colors : null,
    };
}

/// <summary>Data the page keeps in the settings file: the agent cost ledger, and the values last used in snippets.</summary>
internal sealed record SettingsData
{
    public IReadOnlyDictionary<string, CostDay>? CostLedger { get; init; }
    /// <summary>Each snippet's variables, as last filled in.</summary>
    public IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>>? SnippetValues { get; init; }

    public SettingsData Normalize() => this;
}

/// <summary>The checks the groups share.</summary>
internal static class SettingChecks
{
    /// <summary>A colour as #RRGGBB.</summary>
    private const int HexColourLength = 7;
    private const char HexColourMark = '#';

    /// <summary>The value when it's one of the allowed ones, else the default.</summary>
    public static T OneOf<T>(T value, IReadOnlyList<T> allowed, T fallback) => allowed.Contains(value) ? value : fallback;

    /// <summary>The text trimmed; null when there's none.</summary>
    public static string? Trimmed(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();

    /// <summary>Shaped like #RRGGBB (a trigger's colour, which the page checks itself).</summary>
    public static bool HasColourShape(string? value) => value is { Length: HexColourLength } && value[0] == HexColourMark;

    public static bool IsHexColour(string? value) =>
        value is { Length: HexColourLength } && value[0] == HexColourMark && value.Skip(1).All(Uri.IsHexDigit);

    /// <summary>A name Windows accepts for an environment variable (no '=', not empty).</summary>
    public static bool IsVariableName(string name) => name.Length > 0 && !name.Contains('=') && !name.Contains('\0');
}
