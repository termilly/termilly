using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Tests;

/// <summary>settings.json from before groups (version 1) moved into its groups, from real files (Settings\v1-*.json).</summary>
public sealed class SettingsMigrationTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public SettingsMigrationTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static string Fixture(string name) => Path.Combine(AppContext.BaseDirectory, "Settings", name);

    private string Copy(string name)
    {
        var path = Path.Combine(_dir, "settings.json");
        File.Copy(Fixture(name), path, overwrite: true);
        return path;
    }

    private static string Json(AppSettings settings) => JsonSerializer.Serialize(settings, AppSettings.Json);

    [Fact]
    public void The_default_version_1_file_becomes_the_default_settings()
    {
        var settings = SettingsFile.Load(Copy("v1-default.json"));

        Assert.Equal(Json(new AppSettings().Normalize()), Json(settings));
    }

    [Fact]
    public void Every_setting_of_version_1_has_a_place_in_a_group_unless_its_feature_is_gone()
    {
        var v1 = (JsonObject)JsonNode.Parse(File.ReadAllText(Fixture("v1-default.json")))!;
        var moved = SettingsMigration.ToVersion2(v1);

        // The AI assistant's settings (aiProvider…) are left behind: the assistant was removed after 1.1.0.
        var retired = v1.Count(s => s.Key.StartsWith("ai", StringComparison.Ordinal));
        var count = moved.Where(g => g.Value is JsonObject).Sum(g => ((JsonObject)g.Value!).Count);
        Assert.Equal(v1.Count - retired, count);
    }

    [Fact]
    public void A_customised_file_keeps_every_value_in_its_group()
    {
        var s = SettingsFile.Load(Copy("v1-custom.json"));

        Assert.Equal(("Cascadia Mono", 16.0, "block", false, 1.4, 20000), (s.Terminal.FontFamily, s.Terminal.FontSize, s.Terminal.CursorStyle, s.Terminal.CursorBlink, s.Terminal.LineHeight, s.Terminal.Scrollback));
        Assert.Equal(("cleartype", false, false, "acme.solarized/dark", false), (s.Terminal.TextSmoothing, s.Terminal.InlineImages, s.Terminal.ProgramClipboard, s.Terminal.Colors, s.Terminal.Ports));
        Assert.Equal(("nord", "Segoe UI Variable", false, false, false, false), (s.Interface.Theme, s.Interface.Font, s.Interface.ShowActivity, s.Interface.ConfirmCloseWorkspace, s.Interface.GitStatus, s.Interface.CheckForUpdates));
        Assert.Equal(["acme.solarized"], s.Interface.DisabledPlugins!);
        Assert.Equal(("pwsh", "API", "Use the VPN first", false, false), (s.Shells.DefaultProfile, s.Shells.Profiles![0].Name, s.Shells.Notes!["pwsh"], s.Shells.Integration, s.Shells.DynamicSources));
        Assert.Equal(("COM5", "n1"), (s.Shells.SerialPorts![0].Port, s.Shells.NetworkConsoles![0].Id));
        Assert.Equal(("Deploy", "notify"), (s.Commands.Snippets![0].Name, s.Commands.Triggers![0].Action));
        Assert.Equal((false, false, false, true), (s.Notifications.NeedsInput, s.Notifications.Error, s.Notifications.Done, s.Notifications.JumpHotkey));
        Assert.Equal((true, "Alt+F12", 70, false, "quake"), (s.Quake.Enabled, s.Quake.Chord, s.Quake.Height, s.Quake.AutoHide, s.Quake.Workspace));
        Assert.Equal(("layout", 90, 5000, false, true, true, true), (s.Session.Restore, s.Session.HistoryDays, s.Session.HiddenScrollback, s.Session.SaveOutput, s.Session.RedactSecrets, s.Session.BackgroundShells, s.Session.BackgroundAtSignIn));
        Assert.Equal(("prod", "never", true, false, "ssh-db"), (s.Safety.Environments![0].Id, s.Safety.ProdPaste, s.Safety.ProdTint, s.Safety.PasteWarning, s.Safety.PasteWarningOff![0]));
        Assert.Equal((@"D:\logs", "raw", true, false, 30, "prod", "ssh-db"), (s.Logging.Folder, s.Logging.Format, s.Logging.Timestamps, s.Logging.Redact, s.Logging.KeepDays, s.Logging.Tags![0], s.Logging.Profiles![0]));
        Assert.Equal((@"D:\casts", false, true, 250), (s.Recording.Folder, s.Recording.Redact, s.Recording.Agents, s.Recording.MaxMb));
        Assert.Equal((false, false, "main", "db", "pg"), (s.Ssh.KeepAlive, s.Ssh.Reconnect, s.Ssh.Attach!["ssh-db"], s.Ssh.Connections![0].Name, s.Ssh.Forwards![0].Name));
        Assert.Equal((false, 4, false, true, "focused", "tokens", false, false), (s.Agents.Integration, s.Agents.Limit, s.Agents.ReadDefault, s.Agents.ApiAllowInput, s.Agents.Line, s.Agents.CostDisplay, s.Agents.ClaudeUsage, s.Agents.ClaudeLimits));
        Assert.Equal((false, "float", false, false, false, "git", "file", "last", "session"), (s.Changes.Enabled, s.Changes.Placement, s.Changes.Links, s.Changes.Button, s.Changes.Shortcut, s.Changes.Source, s.Changes.View, s.Changes.Compare, s.Changes.Keep));
        Assert.Equal((25, false, true, 8192, "sideBySide", "follow", "diff", false), (s.Changes.Context, s.Changes.Highlight, s.Changes.Wrap, s.Changes.MaxFileKb, s.Changes.Layout, s.Changes.Follow, s.Changes.NewFile, s.Changes.ShellFiles));
        Assert.Equal((true, true, 9876), (s.Checkin.Enabled, s.Checkin.Answer, s.Checkin.Port));
        Assert.Equal("installed", s.Remote.Setup!["ssh-db"]);
        Assert.Equal((true, "ssh-db", 1760700000000L, "#2E3440", true, "1.2.0"), (s.UiState.TourSeen, s.UiState.RemotePinned![0], s.UiState.RemoteRecent!["ssh-db"], s.UiState.WindowColors!.Background, s.UiState.StopAgentConfirmed, s.UiState.SkippedVersion));
        Assert.Equal((1.25, "staging"), (s.Data.CostLedger!["2026-10-17"].Total, s.Data.SnippetValues!["s1"]["env"]));
    }

    [Fact]
    public void Unknown_settings_are_left_behind_and_odd_values_become_defaults()
    {
        var path = Copy("v1-unknown.json");
        var s = SettingsFile.Load(path);

        Assert.Equal((TerminalSettings.MaxFontSize, "bar", 30), (s.Terminal.FontSize, s.Terminal.CursorStyle, s.Session.HistoryDays));
        Assert.Equal((true, 50, "path", CheckinServer.DefaultPort), (s.Quake.Enabled, s.Quake.Height, s.Changes.Source, s.Checkin.Port));
        Assert.Null(s.UiState.WindowColors);
        var written = File.ReadAllText(path);
        Assert.DoesNotContain("oldSettingNobodyRemembers", written);
        Assert.DoesNotContain("experimentalThing", written);
        Assert.DoesNotContain("aiProvider", written);
    }

    [Fact]
    public void The_retired_AI_assistant_is_dropped_and_its_key_found_only_when_it_was_Anthropic()
    {
        var path = Path.Combine(_dir, "settings.json");
        File.WriteAllText(path, """{ "version": 2, "ai": { "provider": "anthropic", "model": "x" }, "quake": { "enabled": true } }""");

        Assert.True(SettingsFile.NamesAnthropicAssistant(path));
        var s = SettingsFile.Load(path);
        Assert.True(s.Quake.Enabled);
        SettingsFile.Save(s, path);
        Assert.Null(JsonNode.Parse(File.ReadAllText(path))!["ai"]);
        Assert.False(SettingsFile.NamesAnthropicAssistant(path));

        File.WriteAllText(path, """{ "version": 2, "ai": { "provider": "local" } }""");
        Assert.False(SettingsFile.NamesAnthropicAssistant(path));
        Assert.False(SettingsFile.NamesAnthropicAssistant(Path.Combine(_dir, "missing.json")));
    }

    [Fact]
    public void The_file_is_written_grouped_and_the_original_kept_once()
    {
        var path = Copy("v1-custom.json");

        SettingsFile.Load(path);
        var written = (JsonObject)JsonNode.Parse(File.ReadAllText(path))!;
        Assert.Equal(AppSettings.CurrentVersion, written["version"]!.GetValue<int>());
        Assert.Equal("Cascadia Mono", written["terminal"]!["fontFamily"]!.GetValue<string>());
        var copy = Path.Combine(_dir, "settings.v1.json");
        Assert.Equal(File.ReadAllText(Fixture("v1-custom.json")), File.ReadAllText(copy));

        // Read again: already grouped, so nothing moves and the copy stays the original.
        Assert.Equal("Cascadia Mono", SettingsFile.Load(path).Terminal.FontFamily);
        Assert.Equal(File.ReadAllText(Fixture("v1-custom.json")), File.ReadAllText(copy));
    }

    [Fact]
    public void The_page_knows_the_same_groups()
    {
        var store = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "wwwroot", "js", "store.js"));
        var list = store[store.IndexOf("GROUPS = Object.freeze({", StringComparison.Ordinal)..];
        var page = System.Text.RegularExpressions.Regex.Matches(list[..list.IndexOf('}')], "'(\\w+)'").Select(m => m.Groups[1].Value);

        var host = typeof(AppSettings).GetProperties().Where(p => p.PropertyType.IsClass && p.PropertyType != typeof(string))
            .Select(p => AppSettings.GroupName(p.Name));
        Assert.Equal(host.Order(StringComparer.Ordinal), page.Order(StringComparer.Ordinal));
    }

    [Fact]
    public void A_group_from_the_page_replaces_that_group_and_is_checked()
    {
        var before = new AppSettings { Quake = new() { Enabled = true } };
        var values = JsonDocument.Parse("""{ "source": "git", "context": 7 }""").RootElement;

        var after = before.WithGroup("changes", values);

        Assert.Equal(("git", SettingValues.ChangeContext.Default), (after.Changes.Source, after.Changes.Context));
        Assert.True(after.Quake.Enabled);
        Assert.Same(before, before.WithGroup("nothing", values));
    }
}
