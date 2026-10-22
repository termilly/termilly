using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Sends what boots the page: settings, profiles, saved workspaces, the last snapshot, terminals the background host
/// kept, and the fonts (once). While history can't be unlocked it sends only "locked", and the page asks for the
/// recovery code first.
/// </summary>
internal sealed class PageBoot(
    PageChannel page, ISettingsStore settings, Vault vault, WorkspaceStore workspaces, SessionSnapshot snapshot, ProfileCatalog profiles,
    BackgroundHost host, IFontCatalog fonts)
{
    private bool _fontsSent;

    public async Task SendAsync()
    {
        if (vault.IsLocked)
        {
            page.Post(new ToPage.SecurityLocked());
        }
        else
        {
            var current = settings.Current;
            using var saved = workspaces.Load();
            var liveSessions = await host.LiveSessionsAsync().ConfigureAwait(false);
            using var last = current.Session.Restore == SettingValues.RestoreSession.Scrollback ? snapshot.Load() : null;
            profiles.Detect(); // picks up hosts added to ~/.ssh/config since start-up when the page reloads
            page.Post(new ToPage.Boot(
                current, profiles.Summaries(), saved?.RootElement, last?.RootElement, liveSessions,
                new ToPage.SecurityInfo(vault.IsNew ? vault.RecoveryCode() : null, vault.Archives.Count),
                new ToPage.AboutInfo(AppVersion.Current, AppPaths.DataDirectory, RemoteIntegration.VersionIn(),
                    CrashLog.Recent(AppPaths.DataDirectory, DateTimeOffset.Now - CrashLog.RecentFor))));
        }

        if (!_fontsSent)
        {
            _fontsSent = true;
            var (all, monospace, realBold) = await Task.Run(fonts.Read).ConfigureAwait(false);
            page.Post(new ToPage.Fonts(monospace, all, realBold));
        }
    }
}

/// <summary>Settings, profiles and plugins.</summary>
internal sealed class SettingsHandler(
    PageChannel page, ISettingsStore settings, PageBoot boot, ProfileCatalog profiles, ISignInStart signInStart, IDesktopShell desktop) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.SettingsLoad>(_ => boot.SendAsync());
        router.On<FromPage.SettingsSave>(m => Save(m.Group, m.Values));
        router.On<FromPage.ProfilesRefresh>(_ => profiles.Refresh());
        router.On<FromPage.PluginsList>(_ => Task.Run(() => page.Post(new ToPage.PluginList(Plugins.Load()))));
        router.On<FromPage.PluginsOpen>(_ =>
        {
            Directory.CreateDirectory(Plugins.FolderPath);
            desktop.OpenFolder(Plugins.FolderPath);
        });
    }

    /// <summary>A group of Settings from the page: checked, saved, and followed by what depends on them.</summary>
    private void Save(string group, JsonElement values)
    {
        AppSettings updated;
        try
        {
            updated = settings.Current.WithGroup(group, values);
        }
        catch (JsonException)
        {
            return; // not the group's shape: nothing is saved
        }
        settings.Save(updated);
        var session = updated.Session;
        signInStart.Set(session.BackgroundShells && session.BackgroundAtSignIn && File.Exists(HostClient.HostExe), HostClient.HostExe);
    }
}

/// <summary>What the page keeps and the host stores: workspaces, the snapshot of the terminals, closed terminals and commands.</summary>
internal sealed class HistoryHandler(
    PageChannel page, ISettingsStore settings, Vault vault, WorkspaceStore workspaces, SessionSnapshot snapshot, HistoryStore history,
    CommandHistory commands, SyncHandler sync, LastSnapshot last) : IMessageHandler
{
    private const string NoEntries = "[]";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.StateSave>(m => Storage.Try(() => workspaces.Save(m.State)));
        router.On<FromPage.SnapshotSave>(m =>
        {
            Storage.Try(() => snapshot.Save(m.Snapshot, settings.Current.Session.RedactSecrets));
            if (m.Final)
            {
                last.Arrived();
            }
        });
        router.On<FromPage.HistoryAdd>(m => Storage.Try(() => history.Add(m.Entry, settings.Current.Session.RedactSecrets)));
        router.On<FromPage.HistoryList>(_ => SendHistory());
        router.On<FromPage.HistoryCommand>(m =>
        {
            Storage.Try(() => commands.Add(m.Entry, settings.Current.Session.RedactSecrets));
            sync.ShareSoon();
        });
        router.On<FromPage.HistoryCommands>(_ => SendCommands());
        router.On<FromPage.HistoryDelete>(m => Storage.Try(() => history.Delete(m.Id)));
        router.On<FromPage.HistoryClear>(_ =>
        {
            Storage.Try(history.Clear);
            Storage.Try(commands.Clear);
            SendHistory();
        });
    }

    /// <summary>Closed terminals, newest first; none while history is locked or can't be read.</summary>
    public void SendHistory()
    {
        try
        {
            if (vault.IsLocked)
            {
                throw new InvalidOperationException("History is locked.");
            }
            using var entries = history.List(settings.Current.Session.HistoryDays);
            page.Post(new ToPage.History(entries.RootElement));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException or InvalidOperationException)
        {
            page.Post(new ToPage.History(Array.Empty<object>()));
        }
    }

    private void SendCommands()
    {
        var json = NoEntries;
        Storage.Try(() => json = vault.IsLocked ? NoEntries : commands.List(settings.Current.Session.HistoryDays));
        page.Post(new ToPage.CommandList(JsonDocument.Parse(json).RootElement));
    }
}

/// <summary>
/// The page's last snapshot of its terminals, asked for when the window closes: the window closes once it's in (or
/// after a moment, if the page doesn't answer).
/// </summary>
internal sealed class LastSnapshot(PageChannel page, ISettingsStore settings, TerminalSessions terminals, IAppWindow window)
{
    /// <summary>The window asked to close and the page was asked for a last snapshot.</summary>
    public bool Requested { get; private set; }

    /// <summary>Whether a closing window should ask: Settings bring terminals back after a restart, there are terminals, and it hasn't asked.</summary>
    public bool Wanted => !Requested && settings.Current.Session.Restore == SettingValues.RestoreSession.Scrollback && !terminals.IsEmpty;

    public void Request()
    {
        Requested = true;
        page.Post(new ToPage.SnapshotRequest());
    }

    /// <summary>The page's last snapshot is in: if the window asked for it, it closes now.</summary>
    public void Arrived()
    {
        if (Requested)
        {
            window.CloseNow();
        }
    }
}

/// <summary>The recovery code, unlocking after a password reset, and history set aside by "Start fresh" (Security/Vault.cs).</summary>
internal sealed class SecurityHandler(
    PageChannel page, Vault vault, PageBoot boot, HistoryHandler history, CommandHistory commands, HistorySync sync) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.SecurityRecover>(m => Guard(() =>
        {
            if (vault.IsLocked && vault.TryRecover(m.Code ?? ""))
            {
                _ = boot.SendAsync();
            }
            else
            {
                page.Post(new ToPage.SecurityError("That recovery code doesn't unlock this history."));
            }
        }));
        router.On<FromPage.SecurityStartFresh>(fresh => Guard(() =>
        {
            if (vault.IsLocked)
            {
                vault.StartFresh();
                commands.Reset();
                sync.Reset();
                _ = boot.SendAsync();
            }
        }));
        router.On<FromPage.SecuritySaved>(_ => Guard(vault.ConfirmCodeSaved));
        router.On<FromPage.SecurityCode>(_ => Guard(() => page.Post(new ToPage.RecoveryCode(vault.IsLocked ? null : vault.RecoveryCode()))));
        router.On<FromPage.SecurityRegenerate>(_ => Guard(() => page.Post(new ToPage.RegeneratedCode(vault.RegenerateRecoveryCode()))));
        router.On<FromPage.SecurityRestore>(m => Guard(() =>
        {
            var restored = vault.RestoreArchives(m.Code ?? "");
            page.Post(new ToPage.SecurityRestored(restored, vault.Archives.Count));
            if (restored > 0)
            {
                history.SendHistory();
            }
        }));
    }

    /// <summary>Runs a vault operation; what the vault refuses goes to the page as security:error.</summary>
    private void Guard(Action operation)
    {
        try
        {
            operation();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is CryptographicException or InvalidOperationException)
        {
            page.Post(new ToPage.SecurityError(e.Message));
        }
    }
}

/// <summary>The window and the page's life: the title bar, start-up, notifications, links, folders and the folder picker.</summary>
internal sealed class WindowHandler : IMessageHandler
{
    private const string FolderPickerTitle = "Choose the folder new terminals start in";
    private static readonly string[] WebSchemes = [Uri.UriSchemeHttp, Uri.UriSchemeHttps];

    private readonly PageChannel _page;
    private readonly IAppWindow _window;
    private readonly IFileDialogs _dialogs;
    private readonly IDesktopShell _desktop;
    private readonly INotifier _notifier;
    private readonly PageApi _api;
    private readonly TmuxClients _tmux;

    public WindowHandler(PageChannel page, IAppWindow window, IFileDialogs dialogs, IDesktopShell desktop, INotifier notifier, PageApi api, TmuxClients tmux)
    {
        (_page, _window, _dialogs, _desktop, _notifier, _api, _tmux) = (page, window, dialogs, desktop, notifier, api, tmux);
        // A notification was clicked: its terminal comes forward.
        notifier.Clicked += terminal =>
        {
            window.BringToFront();
            page.Post(new ToPage.FocusTerminal(terminal));
        };
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.Window>(_window.Act);
        router.On<FromPage.Ready>(_ => Ready());
        router.On<FromPage.PageError>(m => Console.Error.WriteLine($"termilly page: {m.Message} ({m.Where})"));
        router.On<FromPage.Notify>(m => _notifier.Notify(m.Id, m.Title ?? Product.Name, m.Body ?? ""));
        router.On<FromPage.NotifyWithdraw>(m => _notifier.Withdraw(m.Id));
        router.On<FromPage.Badge>(m => _window.ShowBadge(m.Count));
        router.On<FromPage.OpenUrl>(m =>
        {
            if (Uri.TryCreate(m.Url, UriKind.Absolute, out var uri) && WebSchemes.Contains(uri.Scheme))
            {
                _desktop.OpenUrl(uri);
            }
        });
        router.On<FromPage.OpenPath>(m => _desktop.ShowPath(m.Path));
        router.On<FromPage.DataDirOpen>(_ => _desktop.OpenFolder(AppPaths.DataDirectory));
        router.On<FromPage.PickFolder>(m => PickFolderAsync(m.RequestId, m.Initial));
        _window.RegisterMessages(router);
    }

    /// <summary>The page reported in: tmux clients a reloaded page had are gone, and folders handed over meanwhile open.</summary>
    private void Ready()
    {
        _tmux.StopAll(); // a reloaded page has no tmux clients of its own
        _window.PageReady();
        _api.PageReady();
    }

    private async Task PickFolderAsync(string? requestId, string? initial)
    {
        var path = await _dialogs.PickFolderAsync(FolderPickerTitle, AppPaths.ResolveWorkingDirectory(initial)).ConfigureAwait(false);
        _page.Post(new ToPage.FolderPicked(requestId, path));
    }
}
