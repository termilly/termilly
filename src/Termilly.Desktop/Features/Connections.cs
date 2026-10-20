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

/// <summary>The SFTP side panel (Sftp.cs, js/sftp.js): listing a server's folders, file operations, uploads.</summary>
internal sealed class SftpHandler(PageChannel page, Sftp sftp, TerminalSessions terminals, IFileDialogs dialogs) : IMessageHandler
{
    private const string NotSsh = "This terminal isn't an SSH host or connection.";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.SftpList>(m => Task.Run(() => List(m.Id, m.RequestId, m.Path)));
        router.On<FromPage.SftpOp>(m => Task.Run(() => Operate(m)));
        router.On<FromPage.SftpPut>((m, files) => Task.Run(() => Upload(m.Id, m.RequestId, m.Dir, files ?? m.Paths ?? [])));
        router.On<FromPage.SftpPick>(m => PickAndUploadAsync(m.Id, m.RequestId, m.Dir));
    }

    private string? ArgumentsOf(string terminal) => terminals.ProfileOf(terminal) is { } profile ? Sftp.ArgumentsFor(profile.CommandLine) : null;

    private void List(string terminal, string? requestId, string? path)
    {
        try
        {
            var (listed, entries) = sftp.List(ArgumentsOf(terminal) ?? throw new IOException(NotSsh), path);
            page.Post(new ToPage.SftpListing(requestId, listed, entries));
        }
        catch (IOException ex)
        {
            page.Post(new ToPage.SftpListingFailed(requestId, ex.Message));
        }
    }

    private void Operate(FromPage.SftpOp m)
    {
        try
        {
            var arguments = ArgumentsOf(m.Id) ?? throw new IOException(NotSsh);
            var local = Run(arguments, m.Op, m.Path ?? throw new IOException("No file given."), m.To);
            page.Post(new ToPage.SftpDone(m.RequestId, local));
        }
        catch (IOException ex)
        {
            page.Post(new ToPage.SftpFailed(m.RequestId, ex.Message));
        }
    }

    /// <summary>Runs one file operation on the server; a download's local path, else null.</summary>
    private string? Run(string arguments, string? op, string remote, string? to)
    {
        switch (op)
        {
            case SftpOperations.Get:
                Directory.CreateDirectory(Sftp.DownloadDirectory);
                var local = FreeLocalName(Path.Combine(Sftp.DownloadDirectory, Path.GetFileName(remote)));
                sftp.Run(arguments, [$"get {Sftp.Quote(remote)} {Sftp.Quote(local)}"]);
                return local;
            case SftpOperations.Remove or SftpOperations.RemoveDirectory or SftpOperations.MakeDirectory:
                sftp.Run(arguments, [$"{op} {Sftp.Quote(remote)}"]);
                return null;
            case SftpOperations.Rename:
                sftp.Run(arguments, [$"rename {Sftp.Quote(remote)} {Sftp.Quote(to ?? remote)}"]);
                return null;
            default:
                throw new IOException("Unknown file operation.");
        }
    }

    /// <summary>Uploads files dropped or picked in the panel to a remote folder, one at a time, reporting each.</summary>
    private void Upload(string terminal, string? requestId, string? directory, IReadOnlyList<string> files)
    {
        var arguments = ArgumentsOf(terminal);
        foreach (var file in files)
        {
            try
            {
                if (arguments is null || directory is null)
                {
                    throw new IOException(NotSsh);
                }
                if (!File.Exists(file))
                {
                    throw new IOException("Only files can be uploaded, not folders.");
                }
                sftp.Run(arguments, [$"put {Sftp.Quote(file)} {Sftp.Quote(Sftp.Join(directory, Path.GetFileName(file)))}"]);
                page.Post(new ToPage.SftpUploaded(requestId, Path.GetFileName(file)));
            }
            catch (IOException ex)
            {
                page.Post(new ToPage.SftpUploadFailed(requestId, Path.GetFileName(file), ex.Message));
            }
        }
    }

    /// <summary>The panel's Upload button where the host picks the files: the page hears which, then each one's result.</summary>
    private async Task PickAndUploadAsync(string terminal, string? requestId, string? directory)
    {
        var files = await dialogs.PickFilesAsync("Upload files").ConfigureAwait(false);
        if (files.Count > 0)
        {
            page.Post(new ToPage.SftpQueued(requestId, files.Select(Path.GetFileName)));
            _ = Task.Run(() => Upload(terminal, requestId, directory, files));
        }
    }

    /// <summary>"name.txt", or "name (1).txt" when that's taken.</summary>
    private static string FreeLocalName(string path)
    {
        var dir = Path.GetDirectoryName(path)!;
        var stem = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 1; File.Exists(path); i++)
        {
            path = Path.Combine(dir, $"{stem} ({i}){ext}");
        }
        return path;
    }
}
