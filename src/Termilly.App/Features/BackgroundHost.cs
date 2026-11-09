using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The background host (Termilly.Host), when Settings keep shells running after the window closes: the connection
/// to it, made at start, and again after "Stop background shells".
/// </summary>
internal sealed class BackgroundHost : IDisposable
{
    /// <summary>With shells kept by the background host, their hooks must still find the next window: one fixed pipe name.</summary>
    private const string FixedPipeName = PipeNames.Main;
    /// <summary>How long a new shell waits for the host to answer before it runs in this window instead.</summary>
    private static readonly TimeSpan ConnectWait = TimeSpan.FromSeconds(8);

    private readonly ISettingsStore _settings;
    private Task<HostClient?> _host;

    public BackgroundHost(ISettingsStore settings)
    {
        _settings = settings;
        _host = settings.Current.Session.BackgroundShells ? Task.Run(HostClient.Connect) : Task.FromResult<HostClient?>(null);
    }

    /// <summary>The agent pipe's name: fixed while the background host keeps shells, else one of the window's own.</summary>
    public string? PipeName => _settings.Current.Session.BackgroundShells ? FixedPipeName : null;

    /// <summary>
    /// The host to run a new shell in: the one connected at start, or a new one if that went away. Null when Settings
    /// don't keep shells running or no host can be reached; the shell then runs in this window as usual.
    /// </summary>
    public HostClient? Current()
    {
        if (!_settings.Current.Session.BackgroundShells)
        {
            return null;
        }
        if (_host.IsCompletedSuccessfully && _host.Result is { IsConnected: true } connected)
        {
            return connected;
        }
        if (_host.IsCompleted)
        {
            _host = Task.Run(HostClient.Connect);
        }
        return _host.Wait(ConnectWait) ? _host.Result : null;
    }

    /// <summary>Terminals the host kept while no window was open, which the page takes back.</summary>
    public async Task<string[]> LiveSessionsAsync()
    {
        var host = await _host.ConfigureAwait(false);
        return host?.Running.Where(s => s.Value.Alive).Select(s => s.Key).ToArray() ?? [];
    }

    /// <summary>Ends the host and every shell it runs; false when there was none.</summary>
    public bool ShutDown()
    {
        if (_host.IsCompletedSuccessfully && _host.Result is { } running)
        {
            running.Shutdown();
            return true;
        }
        return false;
    }

    /// <summary>The window is closing: the shells stay with the host.</summary>
    public void Dispose()
    {
        if (_host.IsCompletedSuccessfully)
        {
            _host.Result?.Dispose();
        }
    }
}
