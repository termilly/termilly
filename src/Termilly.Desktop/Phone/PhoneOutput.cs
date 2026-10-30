using System.Collections.Concurrent;
using Termilly.Desktop.Features;
using Termilly.Pty;

namespace Termilly.Desktop.Phone;

/// <summary>
/// What each terminal printed lately, for a phone that opens it (docs/phone.md): kept only while Termilly on a phone
/// is on, as raw terminal output, so the phone's terminal draws it as the PC's did; then everything new, as it comes.
/// </summary>
internal sealed class PhoneOutput : IDisposable
{
    /// <summary>How much of each terminal's output is kept, in characters: a screenful and a good stretch above it.</summary>
    private const int Capacity = 256 * 1024;

    private readonly TerminalSessions _sessions;
    private readonly ConcurrentDictionary<string, OutputRing> _rings = new();

    /// <summary>A terminal printed something (only while <see cref="Keeping"/>).</summary>
    public event Action<string, string>? Printed;

    /// <summary>Whether output is kept and passed on: while the phone server runs.</summary>
    public bool Keeping { get; set; }

    public PhoneOutput(TerminalSessions sessions)
    {
        _sessions = sessions;
        sessions.Output += OnOutput;
        sessions.Restarting += Forget;
        sessions.Closed += Forget;
    }

    /// <summary>What a terminal printed lately, oldest first; empty for one not seen yet.</summary>
    public string Recent(string id) => _rings.TryGetValue(id, out var ring) ? ring.Text() : "";

    private void OnOutput(string id, string data)
    {
        if (!Keeping)
        {
            return;
        }
        _rings.GetOrAdd(id, _ => new OutputRing(Capacity)).Add(data);
        Printed?.Invoke(id, data);
    }

    private void Forget(string id) => _rings.TryRemove(id, out _);

    /// <summary>Lets go of everything kept (the phone server stopped).</summary>
    public void Clear() => _rings.Clear();

    public void Dispose()
    {
        _sessions.Output -= OnOutput;
        _sessions.Restarting -= Forget;
        _sessions.Closed -= Forget;
    }
}
