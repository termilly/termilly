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
        var keeps = settings.Current.Session.BackgroundShells;
        _host = keeps ? Task.Run(HostClient.Connect) : Task.FromResult<HostClient?>(null);
        PipeName = keeps ? FixedPipeName : null;
    }

    /// <summary>
    /// The agent pipe's name: fixed when the background host kept shells at start, else one of the window's own. Chosen
    /// once, as the window listens on one pipe until it closes, also after the setting changes.
    /// </summary>
    public string? PipeName { get; }

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

    /// <summary>
    /// Live shells the host runs that aren't this window's terminals: kept ones not taken back, or, with no connection
    /// (background shells turned on after start, or off), every one a host still runs. Waits for a connection being made.
    /// </summary>
    public IReadOnlyList<string> KeptShells() =>
        Connected() is { } connected ? [.. connected.Untaken] : HostClient.AliveShells();

    /// <summary>
    /// Ends the host and every shell it runs, also one this window isn't connected to; done once its process is gone.
    /// </summary>
    public Task ShutDown() => Task.Run(() => HostClient.StopHost(Connected()));

    /// <summary>This window's connection to the host once it's made (one being made is waited for), or null.</summary>
    private HostClient? Connected()
    {
        // Waits without throwing when connecting failed, and without a timer left running after (CA2027).
        ((IAsyncResult)_host).AsyncWaitHandle.WaitOne(ConnectWait);
        return _host.IsCompletedSuccessfully && _host.Result is { IsConnected: true } connected ? connected : null;
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
