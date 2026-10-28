using System.Collections.Concurrent;
using System.ComponentModel;
using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>The credential store (Windows Credential Manager, the Linux keyring), with its refusals told in words.</summary>
internal sealed class Credentials(ICredentialStore store)
{
    public ICredentialStore Store => store;

    /// <summary>Runs a change to the store; when it says no, <paramref name="refused"/> tells the page why.</summary>
    public void Change(Action call, Action<string> refused)
    {
        try
        {
            call();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is Win32Exception or InvalidOperationException)
        {
            refused($"{store.Name} refused it: {e.Message}");
        }
    }

    /// <summary>A read that counts a refusal as "no".</summary>
    public static bool Read(Func<bool> read)
    {
        try
        {
            return read();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }

    /// <summary>Whether a secret is kept under this target.</summary>
    public bool Has(string target) => store.IsAvailable && Read(() => store.Exists(target));
}

/// <summary>
/// The AI assistant (in Termilly until 1.1.0) kept the user's Anthropic API key in the credential store. Now that it's
/// gone, the key is removed at start so none is left behind. Only when settings.json still names Anthropic as its
/// provider: looking in the Linux keyring can ask to unlock it, which no one should see for a key they never saved.
/// </summary>
internal sealed class RetiredAssistantKey(Credentials credentials) : IStartable
{
    private const string Target = "Termilly/ai/anthropic";

    /// <summary>Read when the window is made, before anything saves settings.json without the assistant's group.</summary>
    private readonly bool _wasUsed = SettingsFile.NamesAnthropicAssistant();

    public void Start()
    {
        if (_wasUsed)
        {
            Task.Run(() => credentials.Change(() => credentials.Store.Delete(Target), _ => { }));
        }
    }
}

/// <summary>Settings › SSH: importing hosts from other clients, saved passwords, and port forwards.</summary>
internal sealed class SshHandler : IMessageHandler, IStartable, IDisposable
{
    private const string GoneTarget = "Its SSH host or connection no longer exists.";

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly ProfileCatalog _profiles;
    private readonly Credentials _credentials;
    /// <summary>Each port forward's last state, sent to the page when it asks.</summary>
    private readonly ConcurrentDictionary<string, ToPage.ForwardState> _forwardStates = new();
    private readonly ForwardManager _forwards;

    public SshHandler(PageChannel page, ISettingsStore settings, ProfileCatalog profiles, Credentials credentials)
    {
        (_page, _settings, _profiles, _credentials) = (page, settings, profiles, credentials);
        _forwards = new ForwardManager((id, state, message) => Report(id, state, message));
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.SshImport>(_ => Task.Run(() =>
        {
            var notes = new List<string>();
            var hosts = SshImport.FindAll(notes);
            _page.Post(new ToPage.SshImported(hosts, notes));
        }));
        router.On<FromPage.SshPassword>(m => SavePassword(m.Connection, m.User, m.Password));
        router.On<FromPage.SshPasswordForget>(m =>
        {
            if (_settings.Current.Ssh.Connections?.FirstOrDefault(c => c.Id == m.Connection) is { } forgotten)
            {
                _credentials.Change(() => _credentials.Store.Delete(forgotten.CredentialTarget), Refused);
                PostCredentialStatus();
            }
        });
        router.On<FromPage.SshStatus>(_ =>
        {
            PostCredentialStatus();
            _page.Post(new ToPage.ForwardAll(new Dictionary<string, ToPage.ForwardState>(_forwardStates)));
        });
        router.On<FromPage.SshKnown>(_ => Task.Run(() =>
        {
            var config = SshConfig.DefaultPath;
            _page.Post(new ToPage.SshKnown(SshConfig.Keys(Path.GetDirectoryName(config)!), SshConfig.Read(config)));
        }));
        router.On<FromPage.ForwardStart>(m => StartForward(m.Id));
        router.On<FromPage.ForwardStop>(m => _forwards.Stop(m.Id));
    }

    /// <summary>Port forwards that start on their own.</summary>
    public void Start()
    {
        foreach (var forward in (_settings.Current.Ssh.Forwards ?? []).Where(f => f.AutoStart))
        {
            StartForward(forward.Id);
        }
    }

    private void Refused(string message) => _page.Post(new ToPage.SshError(message));

    private void Report(string id, string state, string? message)
    {
        _forwardStates[id] = new ToPage.ForwardState(state, message);
        _page.Post(new ToPage.ForwardStatus(id, state, message));
    }

    /// <summary>Starts a port forward through its connection or ~/.ssh/config host, with that host's arguments.</summary>
    private void StartForward(string id)
    {
        var forward = _settings.Current.Ssh.Forwards?.FirstOrDefault(f => f.Id == id);
        var target = forward is null ? null : _profiles.All.FirstOrDefault(p => p.Id == forward.Target);
        var ssh = SessionProfiles.SshCommand + " ";
        if (forward is null || target is null || !target.CommandLine.StartsWith(ssh, StringComparison.OrdinalIgnoreCase))
        {
            Report(id, ForwardStates.Failed, GoneTarget);
            return;
        }
        _forwards.Start(forward, target.CommandLine[ssh.Length..], target.Environment);
    }

    /// <summary>Keeps a connection's password in the system's credential store; Termilly itself doesn't keep it.</summary>
    private void SavePassword(string? connectionId, string? user, string? password)
    {
        var connection = _settings.Current.Ssh.Connections?.FirstOrDefault(c => c.Id == connectionId);
        if (connection is null || string.IsNullOrEmpty(password))
        {
            return;
        }
        _credentials.Change(() => _credentials.Store.Save(connection.CredentialTarget, user ?? connection.User ?? "", password, "Saved by Termilly for an SSH connection"), Refused);
        PostCredentialStatus();
    }

    /// <summary>Which connections that sign in with a saved password have one.</summary>
    private void PostCredentialStatus()
    {
        var saved = (_settings.Current.Ssh.Connections ?? []).Where(c => c.Identity == SshIdentities.SavedPassword)
            .ToDictionary(c => c.Id, c => _credentials.Has(c.CredentialTarget));
        _page.Post(new ToPage.SshCredentials(saved, _credentials.Store.IsAvailable, _credentials.Store.Name));
    }

    public void Dispose() => _forwards.Dispose();
}
