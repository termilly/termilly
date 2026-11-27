using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using static Termilly.Desktop.Features.PcWire;

namespace Termilly.Desktop.Features;

/// <summary>
/// Terminals here that show another computer's (js/remotepc.js): each its own connection there, watching that
/// terminal (what it shows, then what it prints), with typing, its size and its prompt history going there. Closing
/// one here, or forgetting its computer, ends its watch, a connection still being made included.
/// </summary>
internal sealed class RemoteWatches(PageChannel page, RemotePcStore store, RemotePcFiles ask, IPcConnector connector) : IMessageHandler, IDisposable
{
    /// <summary>What a phone (or this computer) types at once (Features/Phone.cs takes up to 4096).</summary>
    private const int MaxInput = 4000;

    /// <summary>A terminal here watching one there.</summary>
    private sealed record Watch(string Pc, string Pane, WebSocket Socket, SemaphoreSlim Gate, CancellationTokenSource Stop);

    /// <summary>
    /// A terminal here whose connection there is still being made: closing it cancels that, and the last size it gave
    /// meanwhile is the one the watch starts at (a size sent before the watch exists had nowhere to go).
    /// </summary>
    private sealed class Connecting(CancellationTokenSource stop, int cols, int rows)
    {
        public CancellationTokenSource Stop { get; } = stop;
        public int Cols { get; set; } = cols;
        public int Rows { get; set; } = rows;
    }

    private readonly ConcurrentDictionary<string, Watch> _watches = new();
    /// <summary>Connections being made, by terminal here; with <see cref="_watches"/> changed only under <see cref="_lock"/>.</summary>
    private readonly Dictionary<string, Connecting> _connecting = [];
    private readonly Lock _lock = new();
    private readonly CancellationTokenSource _stop = new();
    private int _disposed;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.PcWatch>(WatchAsync);
        router.On<FromPage.PcUnwatch>(m => Unwatch(m.Tab));
        router.On<FromPage.PcInput>(InputAsync);
        router.On<FromPage.PcPrompts>(PromptsAsync);
        router.On<FromPage.PcRefresh>(m => SendTo(m.Tab, new JsonObject { [Fields.Op] = Kinds.Refresh }));
        router.On<FromPage.PcSize>(Resize);
    }

    /// <summary>A computer was forgotten: its terminals here stop watching.</summary>
    public void Forget(string pcId)
    {
        foreach (var (tab, _) in _watches.Where(w => w.Value.Pc == pcId))
        {
            Unwatch(tab);
        }
    }

    /// <summary>A terminal here gives its size: to the one there, or kept for its watch while it connects.</summary>
    private void Resize(FromPage.PcSize m)
    {
        lock (_lock)
        {
            if (_connecting.TryGetValue(m.Tab, out var connecting))
            {
                (connecting.Cols, connecting.Rows) = (m.Cols, m.Rows);
                return;
            }
        }
        SendTo(m.Tab, new JsonObject { [Fields.Op] = Kinds.Size, [Fields.Cols] = m.Cols, [Fields.Rows] = m.Rows });
    }

    /// <summary>A terminal here opens one there: its own connection, watching it.</summary>
    private async Task WatchAsync(FromPage.PcWatch m)
    {
        Unwatch(m.Tab);
        if (store.List().FirstOrDefault(p => p.Id == m.Id) is not { } pc)
        {
            page.Post(new ToPage.PcLost(m.Tab, "That computer isn’t paired any more."));
            return;
        }
        var stop = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        var connecting = new Connecting(stop, m.Cols, m.Rows);
        lock (_lock)
        {
            _connecting[m.Tab] = connecting;
        }
        WebSocket socket;
        try
        {
            socket = await connector.ConnectAsync(pc, stop.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or System.Security.Authentication.AuthenticationException)
        {
            if (Dropped(m.Tab, connecting))
            {
                page.Post(new ToPage.PcLost(m.Tab, $"{pc.Name} can’t be reached now."));
            }
            stop.Dispose();
            return;
        }
        if (Started(m.Tab, pc, m.Pane, socket, connecting) is { } watch)
        {
            await StartWatchingAsync(m.Tab, pc, watch, connecting).ConfigureAwait(false);
        }
    }

    /// <summary>
    /// The watch of a connection just made, now that the terminal here can be told apart from one closed meanwhile:
    /// null (the connection ended) when it was closed or opened again while connecting.
    /// </summary>
    private Watch? Started(string tab, RemotePc pc, string pane, WebSocket socket, Connecting connecting)
    {
        lock (_lock)
        {
            if (_connecting.GetValueOrDefault(tab) == connecting && !connecting.Stop.IsCancellationRequested)
            {
                _connecting.Remove(tab);
                var watch = new Watch(pc.Id, pane, socket, new SemaphoreSlim(1, 1), connecting.Stop);
                _watches[tab] = watch;
                return watch;
            }
        }
        socket.Abort();
        socket.Dispose();
        connecting.Stop.Dispose();
        return null;
    }

    /// <summary>Asks the computer there to show the terminal, at the size given last, and reads what it sends.</summary>
    private async Task StartWatchingAsync(string tab, RemotePc pc, Watch watch, Connecting connecting)
    {
        try
        {
            var show = new JsonObject { [Fields.Op] = Kinds.Watch, [Fields.Pane] = watch.Pane, [Fields.Cols] = connecting.Cols, [Fields.Rows] = connecting.Rows };
            await PcConnection.SendAsync(watch.Socket, watch.Gate, show, watch.Stop.Token).ConfigureAwait(false);
            _ = Task.Run(() => ReadWatchAsync(tab, pc, watch));
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            if (_watches.TryGetValue(tab, out var still) && still == watch)
            {
                page.Post(new ToPage.PcLost(tab, $"{pc.Name} can’t be reached now."));
                Unwatch(tab);
            }
        }
    }

    /// <summary>Drops a connection being made: true when it was still this terminal's (not closed meanwhile).</summary>
    private bool Dropped(string tab, Connecting connecting)
    {
        lock (_lock)
        {
            if (_connecting.GetValueOrDefault(tab) != connecting)
            {
                return false;
            }
            _connecting.Remove(tab);
            return !connecting.Stop.IsCancellationRequested;
        }
    }

    private async Task ReadWatchAsync(string tab, RemotePc pc, Watch watch)
    {
        try
        {
            while (await PcConnection.ReceiveAsync(watch.Socket, watch.Stop.Token).ConfigureAwait(false) is { } message)
            {
                var type = message[Fields.Type].AsText();
                if ((type == Kinds.Screen || type == Kinds.Output) && message[Fields.Pane].AsText() == watch.Pane)
                {
                    page.Post(new ToPage.PcOutput(tab, message[Fields.Data].AsText() ?? "", type == Kinds.Screen));
                }
                else if (type == Phone.PhoneLive.Kinds.Released && message[Fields.Pane].AsText() == watch.Pane)
                {
                    page.Post(new ToPage.PcPaused(tab, message[Phone.PhoneLive.ByField].AsText()));
                }
                else if (type == Kinds.Answered && message[Fields.Ok].AsBool() == false)
                {
                    page.Post(new ToPage.PcRefused(tab, message[Fields.Error].AsText() ?? "That didn’t go through."));
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException)
        {
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            CrashLog.Caught(e); // a bug: written down; the terminal shows it's lost, as after any loss
        }
        if (_watches.TryGetValue(tab, out var still) && still == watch)
        {
            page.Post(new ToPage.PcLost(tab, $"Lost the connection to {pc.Name}."));
            Unwatch(tab);
        }
    }

    /// <summary>
    /// A terminal here closes (or opens again): its watch there ends, and a connection still being made for it is
    /// cancelled, so it doesn't start a watch for a terminal that's gone.
    /// </summary>
    private void Unwatch(string tab)
    {
        Watch? watch;
        lock (_lock)
        {
            if (_connecting.Remove(tab, out var connecting))
            {
                connecting.Stop.Cancel();
            }
            _watches.TryRemove(tab, out watch);
        }
        if (watch is not null)
        {
            watch.Stop.Cancel();
            watch.Socket.Abort();
            watch.Socket.Dispose();
            watch.Stop.Dispose();
        }
    }

    /// <summary>Prompt history for a terminal here that shows another computer's: that computer's list of its prompts.</summary>
    private async Task PromptsAsync(FromPage.PcPrompts m)
    {
        if (!_watches.TryGetValue(m.Tab, out var watch))
        {
            page.Post(new ToPage.PromptsListed(m.RequestId, [], "That terminal isn’t connected now."));
            return;
        }
        try
        {
            var answer = await ask.AskAsync(RemotePcFiles.TerminalId(watch.Pc, watch.Pane), Phone.PcPrompts.Path, []).ConfigureAwait(false);
            page.Post(new ToPage.PromptsListed(m.RequestId, Phone.PcPromptsApi.Read(answer), Steps: Phone.PcPromptsApi.ReadSteps(answer)));
        }
        catch (IOException e)
        {
            page.Post(new ToPage.PromptsListed(m.RequestId, [], e.Message));
        }
    }

    /// <summary>Typing goes there in pieces a phone may send.</summary>
    private async Task InputAsync(FromPage.PcInput m)
    {
        for (var at = 0; at < m.Data.Length; at += MaxInput)
        {
            await SendToAsync(m.Tab, new JsonObject { [Fields.Op] = Kinds.Input, [Fields.Data] = m.Data.Substring(at, Math.Min(MaxInput, m.Data.Length - at)) }).ConfigureAwait(false);
        }
    }

    private void SendTo(string tab, JsonObject message) => _ = SendToAsync(tab, message);

    private async Task SendToAsync(string tab, JsonObject message)
    {
        if (!_watches.TryGetValue(tab, out var watch))
        {
            return;
        }
        message[Fields.Pane] = watch.Pane;
        try
        {
            await PcConnection.SendAsync(watch.Socket, watch.Gate, message, watch.Stop.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            // The reader says the connection is lost.
        }
    }

    /// <summary>Quitting: every watch ends. Disposed twice by the container is fine (the second does nothing).</summary>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }
        _stop.Cancel();
        lock (_lock)
        {
            foreach (var tab in _connecting.Keys.ToList())
            {
                _connecting.Remove(tab, out var connecting);
                connecting?.Stop.Cancel();
            }
        }
        foreach (var tab in _watches.Keys.ToList())
        {
            Unwatch(tab);
        }
        _stop.Dispose();
    }
}
