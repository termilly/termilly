using System.Collections.Concurrent;

namespace Termilly.Desktop.Features;

/// <summary>
/// The shells started before the page was up (<see cref="EarlyShell"/>), by terminal, until the page opens each
/// terminal and takes its shell over. One the page never opens (its terminal was closed meanwhile) is ended a while
/// after the start, so nothing runs unseen.
/// </summary>
internal sealed class EarlyShells(TerminalSessions terminals) : IDisposable
{
    /// <summary>How long a shell waits for the page to take it over.</summary>
    private static readonly TimeSpan WaitForPage = TimeSpan.FromMinutes(2);

    private readonly ConcurrentDictionary<string, EarlyShell> _shells = new();
    private Timer? _expire;

    /// <summary>The terminals whose shells wait for the page: the page doesn't type their start commands.</summary>
    public string[] Ids => [.. _shells.Keys];

    public void Add(string id, EarlyShell shell)
    {
        _shells[id] = shell;
        _expire ??= new Timer(_ => EndUnclaimed(), null, WaitForPage, Timeout.InfiniteTimeSpan);
    }

    /// <summary>The terminal's early shell, now the page's; null when it has none.</summary>
    public EarlyShell? Take(string id) => _shells.TryRemove(id, out var shell) ? shell : null;

    private void EndUnclaimed()
    {
        foreach (var id in _shells.Keys)
        {
            if (Take(id) is { } shell)
            {
                shell.Dispose();
                terminals.Close(id);
            }
        }
    }

    public void Dispose()
    {
        _expire?.Dispose();
        foreach (var shell in _shells.Values)
        {
            shell.Dispose();
        }
    }
}
