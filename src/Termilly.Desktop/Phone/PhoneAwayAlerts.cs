using System.Collections.Concurrent;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Alerts held back while the user was at the PC (Settings › Phone › Alerts: When I'm away): each waits until the PC
/// has been untouched long enough, then goes; the agent moving on (answered, working again) or a newer alert for the
/// same terminal drops it, and none waits past <see cref="LongestWait"/>.
/// </summary>
internal sealed class PhoneAwayAlerts : IDisposable
{
    private static readonly TimeSpan CheckEvery = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan LongestWait = TimeSpan.FromHours(12);
    private readonly ConcurrentDictionary<string, (JsonObject Alert, DateTime Since)> _waiting = new();
    private readonly Func<JsonObject, Task> _send;
    private readonly Func<TimeSpan?> _idle;
    private readonly TimeSpan _awayAfter;
    private readonly Timer _timer;

    public PhoneAwayAlerts(Func<JsonObject, Task> send, Func<TimeSpan?> idle, TimeSpan awayAfter)
    {
        (_send, _idle, _awayAfter) = (send, idle, awayAfter);
        _timer = new Timer(_ => Check(), null, CheckEvery, CheckEvery);
    }

    /// <summary>A terminal's news, to send once the user is away.</summary>
    public void Hold(string terminal, JsonObject alert) => _waiting[terminal] = (alert, DateTime.UtcNow);

    /// <summary>A terminal's news is old (answered, or a newer one went): it's not sent.</summary>
    public void Drop(string terminal) => _waiting.TryRemove(terminal, out _);

    /// <summary>Sends what waits once the user is away (every few seconds; the tests call it).</summary>
    internal void Check()
    {
        var away = _idle() >= _awayAfter;
        foreach (var (terminal, (alert, since)) in _waiting)
        {
            if (DateTime.UtcNow - since > LongestWait)
            {
                _waiting.TryRemove(terminal, out _);
            }
            else if (away && _waiting.TryRemove(terminal, out _))
            {
                _ = _send(alert);
            }
        }
    }

    public void Dispose() => _timer.Dispose();
}
