using System.Collections.Concurrent;
using System.IO;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>
/// What the window sends the background host, written in order on a thread of its own: a host that's slow to read
/// (busy, or stuck ending a shell) never holds up the thread that sent it, the window's own among them.
/// </summary>
internal sealed class HostWriter : IDisposable
{
    /// <summary>How long closing waits for what's still queued (a last Shutdown) to be written.</summary>
    private static readonly TimeSpan FlushWait = TimeSpan.FromSeconds(1);

    private readonly Stream _pipe;
    private readonly Action _broken;
    private readonly BlockingCollection<HostRequest> _outbox = new();
    private readonly Thread _thread;

    /// <param name="pipe">The connection to the host.</param>
    /// <param name="broken">Called once when the connection can't be written to any more.</param>
    public HostWriter(Stream pipe, Action broken)
    {
        _pipe = pipe;
        _broken = broken;
        _thread = new Thread(WriteLoop) { IsBackground = true, Name = "host-writer" };
        _thread.Start();
    }

    /// <summary>Queues a message for the host; one sent after closing is dropped.</summary>
    public void Send(HostRequest message)
    {
        try
        {
            _outbox.Add(message);
        }
        catch (Exception e) when (e is InvalidOperationException or ObjectDisposedException)
        {
            // Closing or closed: nobody is listening for it any more.
        }
    }

    private void WriteLoop()
    {
        try
        {
            foreach (var message in _outbox.GetConsumingEnumerable())
            {
                HostProtocol.Write(_pipe, message);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            _broken();
        }
    }

    /// <summary>Takes no more messages, and waits briefly for the queued ones to be written (the pipe closes after).</summary>
    public void Dispose()
    {
        _outbox.CompleteAdding();
        if (_thread.Join(FlushWait))
        {
            _outbox.Dispose();
        }
    }
}
