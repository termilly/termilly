using System.Text.Json.Nodes;

namespace Termilly.Desktop;

/// <summary>
/// The settings file before groups (version 1, no version field: every setting at the top level) to version 2: each
/// setting moves into its group, under its group's name for it. Settings no longer known are left behind.
/// </summary>
internal static class SettingsMigration
{
    private const string VersionField = "version";

    /// <summary>A file in the flat shape: it has no version.</summary>
    public static bool IsVersion1(JsonObject file) => file[VersionField] is null;

    public static JsonObject ToVersion2(JsonObject version1)
    {
        var migrated = new JsonObject { [VersionField] = AppSettings.CurrentVersion };
        foreach (var (key, value) in version1)
        {
            if (!Moves.TryGetValue(key, out var to))
            {
                continue;
            }
            var group = AppSettings.GroupName(to.Group);
            if (migrated[group] is not JsonObject target)
            {
                migrated[group] = target = [];
            }
            target[AppSettings.GroupName(to.Key)] = value?.DeepClone();
        }
        return migrated;
    }

    /// <summary>Each version 1 setting: the group it moves to, and its name there.</summary>
    private static readonly Dictionary<string, (string Group, string Key)> Moves = new(StringComparer.Ordinal)
    {
        ["fontFamily"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.FontFamily)),
        ["fontSize"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.FontSize)),
        ["cursorStyle"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.CursorStyle)),
        ["cursorBlink"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.CursorBlink)),
        ["lineHeight"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.LineHeight)),
        ["scrollback"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.Scrollback)),
        ["textSmoothing"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.TextSmoothing)),
        ["inlineImages"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.InlineImages)),
        ["programClipboard"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.ProgramClipboard)),
        ["terminalColors"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.Colors)),
        ["terminalPorts"] = (nameof(AppSettings.Terminal), nameof(TerminalSettings.Ports)),
        ["theme"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.Theme)),
        ["uiFontFamily"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.Font)),
        ["showActivity"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.ShowActivity)),
        ["confirmCloseWorkspace"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.ConfirmCloseWorkspace)),
        ["gitStatus"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.GitStatus)),
        ["checkForUpdates"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.CheckForUpdates)),
        ["disabledPlugins"] = (nameof(AppSettings.Interface), nameof(InterfaceSettings.DisabledPlugins)),
        ["defaultProfile"] = (nameof(AppSettings.Shells), nameof(ShellSettings.DefaultProfile)),
        ["profiles"] = (nameof(AppSettings.Shells), nameof(ShellSettings.Profiles)),
        ["profileNotes"] = (nameof(AppSettings.Shells), nameof(ShellSettings.Notes)),
        ["shellIntegration"] = (nameof(AppSettings.Shells), nameof(ShellSettings.Integration)),
        ["dynamicSources"] = (nameof(AppSettings.Shells), nameof(ShellSettings.DynamicSources)),
        ["serialPorts"] = (nameof(AppSettings.Shells), nameof(ShellSettings.SerialPorts)),
        ["networkConsoles"] = (nameof(AppSettings.Shells), nameof(ShellSettings.NetworkConsoles)),
        ["snippets"] = (nameof(AppSettings.Commands), nameof(CommandSettings.Snippets)),
        ["triggers"] = (nameof(AppSettings.Commands), nameof(CommandSettings.Triggers)),
        ["notifyNeedsInput"] = (nameof(AppSettings.Notifications), nameof(NotificationSettings.NeedsInput)),
        ["notifyError"] = (nameof(AppSettings.Notifications), nameof(NotificationSettings.Error)),
        ["notifyDone"] = (nameof(AppSettings.Notifications), nameof(NotificationSettings.Done)),
        ["globalJumpHotkey"] = (nameof(AppSettings.Notifications), nameof(NotificationSettings.JumpHotkey)),
        ["quake"] = (nameof(AppSettings.Quake), nameof(QuakeSettings.Enabled)),
        ["quakeChord"] = (nameof(AppSettings.Quake), nameof(QuakeSettings.Chord)),
        ["quakeHeight"] = (nameof(AppSettings.Quake), nameof(QuakeSettings.Height)),
        ["quakeAutoHide"] = (nameof(AppSettings.Quake), nameof(QuakeSettings.AutoHide)),
        ["quakeWorkspace"] = (nameof(AppSettings.Quake), nameof(QuakeSettings.Workspace)),
        ["restoreSession"] = (nameof(AppSettings.Session), nameof(SessionSettings.Restore)),
        ["historyDays"] = (nameof(AppSettings.Session), nameof(SessionSettings.HistoryDays)),
        ["hiddenScrollback"] = (nameof(AppSettings.Session), nameof(SessionSettings.HiddenScrollback)),
        ["saveOutput"] = (nameof(AppSettings.Session), nameof(SessionSettings.SaveOutput)),
        ["redactSecrets"] = (nameof(AppSettings.Session), nameof(SessionSettings.RedactSecrets)),
        ["backgroundShells"] = (nameof(AppSettings.Session), nameof(SessionSettings.BackgroundShells)),
        ["backgroundAtSignIn"] = (nameof(AppSettings.Session), nameof(SessionSettings.BackgroundAtSignIn)),
        ["environments"] = (nameof(AppSettings.Safety), nameof(SafetySettings.Environments)),
        ["prodPaste"] = (nameof(AppSettings.Safety), nameof(SafetySettings.ProdPaste)),
        ["prodTint"] = (nameof(AppSettings.Safety), nameof(SafetySettings.ProdTint)),
        ["pasteWarning"] = (nameof(AppSettings.Safety), nameof(SafetySettings.PasteWarning)),
        ["pasteWarningOff"] = (nameof(AppSettings.Safety), nameof(SafetySettings.PasteWarningOff)),
        ["logFolder"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Folder)),
        ["logFormat"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Format)),
        ["logTimestamps"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Timestamps)),
        ["logRedact"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Redact)),
        ["logKeepDays"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.KeepDays)),
        ["logTags"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Tags)),
        ["logProfiles"] = (nameof(AppSettings.Logging), nameof(LoggingSettings.Profiles)),
        ["recordFolder"] = (nameof(AppSettings.Recording), nameof(RecordingSettings.Folder)),
        ["recordRedact"] = (nameof(AppSettings.Recording), nameof(RecordingSettings.Redact)),
        ["recordAgents"] = (nameof(AppSettings.Recording), nameof(RecordingSettings.Agents)),
        ["recordMaxMb"] = (nameof(AppSettings.Recording), nameof(RecordingSettings.MaxMb)),
        ["sshKeepAlive"] = (nameof(AppSettings.Ssh), nameof(SshSettings.KeepAlive)),
        ["sshReconnect"] = (nameof(AppSettings.Ssh), nameof(SshSettings.Reconnect)),
        ["sshAttach"] = (nameof(AppSettings.Ssh), nameof(SshSettings.Attach)),
        ["sshConnections"] = (nameof(AppSettings.Ssh), nameof(SshSettings.Connections)),
        ["forwards"] = (nameof(AppSettings.Ssh), nameof(SshSettings.Forwards)),
        ["agentIntegration"] = (nameof(AppSettings.Agents), nameof(AgentSettings.Integration)),
        ["agentLimit"] = (nameof(AppSettings.Agents), nameof(AgentSettings.Limit)),
        ["agentReadDefault"] = (nameof(AppSettings.Agents), nameof(AgentSettings.ReadDefault)),
        ["apiAllowInput"] = (nameof(AppSettings.Agents), nameof(AgentSettings.ApiAllowInput)),
        ["agentLine"] = (nameof(AppSettings.Agents), nameof(AgentSettings.Line)),
        ["costDisplay"] = (nameof(AppSettings.Agents), nameof(AgentSettings.CostDisplay)),
        ["claudeUsage"] = (nameof(AppSettings.Agents), nameof(AgentSettings.ClaudeUsage)),
        ["claudeLimits"] = (nameof(AppSettings.Agents), nameof(AgentSettings.ClaudeLimits)),
        ["changePreview"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Enabled)),
        ["changePlacement"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Placement)),
        ["changeLinks"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Links)),
        ["changeButton"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Button)),
        ["changeShortcut"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Shortcut)),
        ["changeSource"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Source)),
        ["changeView"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.View)),
        ["changeCompare"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Compare)),
        ["changeKeep"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Keep)),
        ["changeContext"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Context)),
        ["changeHighlight"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Highlight)),
        ["changeWrap"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Wrap)),
        ["changeMaxFileKb"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.MaxFileKb)),
        ["changeLayout"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Layout)),
        ["changeFollow"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.Follow)),
        ["changeNewFile"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.NewFile)),
        ["changeShellFiles"] = (nameof(AppSettings.Changes), nameof(ChangeSettings.ShellFiles)),
        ["remoteSetup"] = (nameof(AppSettings.Remote), nameof(RemoteSettings.Setup)),
        ["tourSeen"] = (nameof(AppSettings.UiState), nameof(UiState.TourSeen)),
        ["remotePinned"] = (nameof(AppSettings.UiState), nameof(UiState.RemotePinned)),
        ["remoteRecent"] = (nameof(AppSettings.UiState), nameof(UiState.RemoteRecent)),
        ["windowColors"] = (nameof(AppSettings.UiState), nameof(UiState.WindowColors)),
        ["stopAgentConfirmed"] = (nameof(AppSettings.UiState), nameof(UiState.StopAgentConfirmed)),
        ["skippedVersion"] = (nameof(AppSettings.UiState), nameof(UiState.SkippedVersion)),
        ["costLedger"] = (nameof(AppSettings.Data), nameof(SettingsData.CostLedger)),
        ["snippetValues"] = (nameof(AppSettings.Data), nameof(SettingsData.SnippetValues)),
    };
}
