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
    private sealed class Connecting(string pc, CancellationTokenSource stop, int cols, int rows)
    {
        public string Pc { get; } = pc;
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

    /// <summary>A computer was forgotten: its terminals here stop watching, those still connecting included.</summary>
    public void Forget(string pcId)
    {
        List<string> tabs;
        lock (_lock)
        {
            tabs = [.. _connecting.Where(c => c.Value.Pc == pcId).Select(c => c.Key), .. _watches.Where(w => w.Value.Pc == pcId).Select(w => w.Key)];
        }
        foreach (var tab in tabs)
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
        if (Begin(m.Tab, pc.Id, m.Cols, m.Rows) is not { } connecting)
        {
            return; // quitting
        }
        WebSocket socket;
        try
        {
            socket = await connector.ConnectAsync(pc, connecting.Stop.Token).ConfigureAwait(false);
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or System.Security.Authentication.AuthenticationException)
        {
            Dropped(m.Tab, connecting, $"{pc.Name} can’t be reached now.");
            connecting.Stop.Dispose();
            return;
        }
        await StartWatchingAsync(m.Tab, pc, new Watch(pc.Id, m.Pane, socket, new SemaphoreSlim(1, 1), connecting.Stop), connecting).ConfigureAwait(false);
    }

    /// <summary>A connection being made for a terminal here, or null once quitting has begun (nothing starts then).</summary>
    private Connecting? Begin(string tab, string pc, int cols, int rows)
    {
        lock (_lock)
        {
            if (_disposed != 0)
            {
                return null;
            }
            var connecting = new Connecting(pc, CancellationTokenSource.CreateLinkedTokenSource(_stop.Token), cols, rows);
            _connecting[tab] = connecting;
            return connecting;
        }
    }

    /// <summary>
    /// Asks the computer there to show the terminal, at the size given last, then makes the watch the terminal's and
    /// reads what it sends. Until it's the terminal's, every size given goes out on it in order (the other computer
    /// ignores a size before its watch, and nothing can overtake them). A terminal closed or opened again while
    /// connecting gets nothing: its connection ends.
    /// </summary>
    private async Task StartWatchingAsync(string tab, RemotePc pc, Watch watch, Connecting connecting)
    {
        try
        {
            if (!await SettledAsync(tab, watch, connecting).ConfigureAwait(false))
            {
                End(watch);
                return;
            }
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or ObjectDisposedException)
        {
            Dropped(tab, connecting, $"{pc.Name} can’t be reached now.");
            End(watch);
            return;
        }
        _ = Task.Run(() => ReadWatchAsync(tab, pc, watch));
    }

    /// <summary>
    /// Sends the watch ask, then each newer size given meanwhile, and makes the watch the terminal's once none is left:
    /// false when the terminal closed or opened again meanwhile.
    /// </summary>
    private async Task<bool> SettledAsync(string tab, Watch watch, Connecting connecting)
    {
        var op = Kinds.Watch;
        (int Cols, int Rows)? sent = null;
        while (true)
        {
            (int Cols, int Rows) size;
            lock (_lock)
            {
                if (!IsConnecting(tab, connecting))
                {
                    return false;
                }
                size = (connecting.Cols, connecting.Rows);
                if (size == sent)
                {
                    _connecting.Remove(tab);
                    _watches[tab] = watch;
                    return true;
                }
            }
            var message = new JsonObject { [Fields.Op] = op, [Fields.Pane] = watch.Pane, [Fields.Cols] = size.Cols, [Fields.Rows] = size.Rows };
            await PcConnection.SendAsync(watch.Socket, watch.Gate, message, watch.Stop.Token).ConfigureAwait(false);
            (sent, op) = (size, Kinds.Size);
        }
    }

    /// <summary>Whether this connection is still the one being made for the terminal here. Under <see cref="_lock"/>.</summary>
    private bool IsConnecting(string tab, Connecting connecting) =>
        _connecting.GetValueOrDefault(tab) == connecting && !connecting.Stop.IsCancellationRequested;

    /// <summary>
    /// Drops a connection being made; when it was still this terminal's (not closed meanwhile), the page is told why,
    /// under the lock, so a terminal opened again meanwhile isn't told.
    /// </summary>
    private void Dropped(string tab, Connecting connecting, string why)
    {
        lock (_lock)
        {
            if (_connecting.GetValueOrDefault(tab) != connecting)
            {
                return;
            }
            _connecting.Remove(tab);
            if (!connecting.Stop.IsCancellationRequested)
            {
                page.Post(new ToPage.PcLost(tab, why));
            }
        }
    }

    private async Task ReadWatchAsync(string tab, RemotePc pc, Watch watch)
    {
        try
        {
            while (await PcConnection.ReceiveAsync(watch.Socket, watch.Stop.Token).ConfigureAwait(false) is { } message)
            {
                // Under the lock with the check: a watch that replaced this one never gets its output.
                lock (_lock)
                {
                    if (_watches.TryGetValue(tab, out var still) && still == watch)
                    {
                        Show(tab, watch, message);
                    }
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
        Unwatch(tab, watch, $"Lost the connection to {pc.Name}.");
    }

    /// <summary>Shows here what the terminal there sent: its screen or output, a pause, or a refusal.</summary>
    private void Show(string tab, Watch watch, JsonObject message)
    {
        var type = message[Fields.Type].AsText();
        var mine = message[Fields.Pane].AsText() == watch.Pane;
        if ((type == Kinds.Screen || type == Kinds.Output) && mine)
        {
            page.Post(new ToPage.PcOutput(tab, message[Fields.Data].AsText() ?? "", type == Kinds.Screen));
        }
        else if (type == Phone.PhoneLive.Kinds.Released && mine)
        {
            page.Post(new ToPage.PcPaused(tab, message[Phone.PhoneLive.ByField].AsText()));
        }
        else if (type == Kinds.Answered && message[Fields.Ok].AsBool() == false)
        {
            page.Post(new ToPage.PcRefused(tab, message[Fields.Error].AsText() ?? "That didn’t go through."));
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
            End(watch);
        }
    }

    /// <summary>
    /// Ends this watch if it's still the terminal's (not one that replaced it), telling the page why under the lock:
    /// a watch that replaced it isn't shown as lost.
    /// </summary>
    private void Unwatch(string tab, Watch watch, string why)
    {
        lock (_lock)
        {
            if (!_watches.TryRemove(new KeyValuePair<string, Watch>(tab, watch)))
            {
                return;
            }
            page.Post(new ToPage.PcLost(tab, why));
        }
        End(watch);
    }

    /// <summary>Closes a watch's connection.</summary>
    private static void End(Watch watch)
    {
        try
        {
            watch.Stop.Cancel();
        }
        catch (ObjectDisposedException)
        {
            // Ended already.
        }
        watch.Socket.Abort();
        watch.Socket.Dispose();
        watch.Stop.Dispose();
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
