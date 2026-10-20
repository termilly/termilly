using System.Collections.Concurrent;

namespace Termilly.Desktop.Features;

/// <summary>
/// The terminals this window runs: each one's shell (here or in the background host), its root process and the
/// profile it was opened with. What else keeps something per terminal (logs, recordings, the change preview, Claude's
/// usage) follows its events.
/// </summary>
internal sealed class TerminalSessions : IDisposable
{
    private readonly ConcurrentDictionary<string, IShellSession> _sessions = new();
    /// <summary>Terminal id → its root process, for the busy watcher's thread (only live processes).</summary>
    private readonly ConcurrentDictionary<string, int> _pids = new();
    /// <summary>Terminal id → the profile it was opened with (SFTP and remote git need its SSH arguments).</summary>
    private readonly ConcurrentDictionary<string, SessionProfile> _profiles = new();

    /// <summary>A terminal printed something.</summary>
    public event Action<string, string>? Output;

    /// <summary>A terminal was resized (columns, rows).</summary>
    public event Action<string, int, int>? Resized;

    /// <summary>A terminal's shell is starting again (a restart, or a new one with that id): what it had is old.</summary>
    public event Action<string>? Restarting;

    /// <summary>A terminal was closed: what was kept for it goes.</summary>
    public event Action<string>? Closed;

    public bool IsEmpty => _sessions.IsEmpty;

    public bool Has(string id) => _sessions.ContainsKey(id);

    public IShellSession? Get(string id) => _sessions.TryGetValue(id, out var session) ? session : null;

    /// <summary>The profile a terminal was opened with, or null.</summary>
    public SessionProfile? ProfileOf(string id) => _profiles.TryGetValue(id, out var profile) ? profile : null;

    /// <summary>Each live terminal's root process, as it is now.</summary>
    public IReadOnlyDictionary<string, int> Pids() => new Dictionary<string, int>(_pids);

    /// <summary>The terminals whose shells the background host runs.</summary>
    public IReadOnlyList<string> Hosted() => [.. _sessions.Where(s => s.Value is HostedSession).Select(s => s.Key)];

    /// <summary>A terminal is starting (again): the shell it had ends, and it's opened with <paramref name="profile"/>.</summary>
    public void Starting(string id, SessionProfile profile)
    {
        _pids.TryRemove(id, out _);
        Restarting?.Invoke(id);
        if (_sessions.TryRemove(id, out var previous))
        {
            previous.Dispose();
        }
        _profiles[id] = profile;
    }

    /// <param name="pid">Its root process; 0 when not known (a serial port, a network console).</param>
    public void Started(string id, IShellSession session, int pid)
    {
        _sessions[id] = session;
        if (pid > 0)
        {
            _pids[id] = pid;
        }
    }

    public void Print(string id, string data) => Output?.Invoke(id, data);

    public void Resize(string id, int columns, int rows)
    {
        Get(id)?.Resize(columns, rows);
        Resized?.Invoke(id, columns, rows);
    }

    /// <summary>A process ended: its id can be reused by an unrelated one, so it isn't watched any more.</summary>
    public void Exited(string id, int pid) => _pids.TryRemove(new KeyValuePair<string, int>(id, pid));

    /// <summary>The terminal was closed: its shell ends.</summary>
    public void Close(string id)
    {
        _pids.TryRemove(id, out _);
        Closed?.Invoke(id);
        if (_sessions.TryRemove(id, out var session))
        {
            session.Dispose();
        }
    }

    /// <summary>Takes a terminal out of this window's list without ending it (its shell went on elsewhere, or is gone).</summary>
    public void Forget(string id)
    {
        _sessions.TryRemove(id, out _);
        _pids.TryRemove(id, out _);
    }

    /// <summary>The window is closing: shells end, except those the background host keeps.</summary>
    public void Dispose()
    {
        foreach (var session in _sessions.Values.Where(s => s is not HostedSession))
        {
            session.Dispose();
        }
        _sessions.Clear();
    }
}
