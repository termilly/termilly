using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Other Termilly computers (js/remotepc.js): each one's live connection, kept open (again every few seconds while it
/// can't be reached) for what it shows, and one more for each of its terminals opened here, which watches that terminal:
/// what it shows, then what it prints, and typing and its size going back. The other computer decides what's allowed
/// (Settings › Phone › Allow typing there).
/// </summary>
internal sealed class RemotePcsHandler(PageChannel page, RemotePcStore store) : IMessageHandler, IStartable, IDisposable
{
    private static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(10);
    /// <summary>What a phone (or this computer) types at once (Features/Phone.cs takes up to 4096).</summary>
    private const int MaxInput = 4000;
    private static class Fields
    {
        public const string Type = "type";
        public const string Op = "op";
        public const string Pane = "pane";
        public const string Data = "data";
        public const string Cols = "cols";
        public const string Rows = "rows";
        public const string State = "state";
        public const string Ok = "ok";
        public const string Error = "error";
    }
    private static class Kinds
    {
        public const string State = "state";
        public const string Screen = "screen";
        public const string Output = "output";
        public const string Answered = "answered";
        public const string Watch = "watch";
        public const string Input = "input";
        public const string Size = "size";
    }

    /// <summary>A computer's state connection: online or not, why, and the last state it sent.</summary>
    private sealed class Live
    {
        public CancellationTokenSource Stop { get; } = new();
        public volatile bool Online;
        public volatile string? Error;
        public volatile string? State;
    }

    /// <summary>A terminal here watching one there.</summary>
    private sealed record Watch(string Pc, string Pane, ClientWebSocket Socket, SemaphoreSlim Gate, CancellationTokenSource Stop);

    private readonly ConcurrentDictionary<string, Live> _live = new();
    private readonly ConcurrentDictionary<string, Watch> _watches = new();
    private readonly CancellationTokenSource _stop = new();
    private int _disposed;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.PcList>(_ => Post());
        router.On<FromPage.PcAdd>(AddAsync);
        router.On<FromPage.PcRemove>(m => Remove(m.Id));
        router.On<FromPage.PcWatch>(WatchAsync);
        router.On<FromPage.PcUnwatch>(m => Unwatch(m.Tab));
        router.On<FromPage.PcInput>(InputAsync);
        router.On<FromPage.PcSize>(m => SendTo(m.Tab, new JsonObject { [Fields.Op] = Kinds.Size, [Fields.Cols] = m.Cols, [Fields.Rows] = m.Rows }));
    }

    public void Start()
    {
        foreach (var pc in store.List())
        {
            Keep(pc);
        }
    }

    private void Post() => page.Post(new ToPage.Pcs(store.List()
        .Select(pc => _live.TryGetValue(pc.Id, out var l) ? new PcView(pc.Id, pc.Name, pc.Address, l.Online, l.Error, l.State) : new PcView(pc.Id, pc.Name, pc.Address, false, null, null))
        .ToList()));

    private async Task AddAsync(FromPage.PcAdd m)
    {
        if (PcConnection.AddressOf(m.Address) is not { } address)
        {
            page.Post(new ToPage.PcAdded(m.RequestId, "That isn’t an address: type the other computer’s, like 192.168.0.20 or desktop.local."));
            return;
        }
        try
        {
            var pc = await PcConnection.PairAsync(address, m.Code, Environment.MachineName + PcConnection.ComputerMark, _stop.Token).ConfigureAwait(false);
            foreach (var old in store.List().Where(p => string.Equals(p.Address, address, StringComparison.OrdinalIgnoreCase)))
            {
                Stop(old.Id);
            }
            store.Add(pc);
            Keep(pc);
            page.Post(new ToPage.PcAdded(m.RequestId, null));
            Post();
        }
        catch (InvalidOperationException e)
        {
            page.Post(new ToPage.PcAdded(m.RequestId, e.Message));
        }
    }

    private void Remove(string id)
    {
        Stop(id);
        store.Remove(id);
        foreach (var (tab, watch) in _watches.Where(w => w.Value.Pc == id))
        {
            Unwatch(tab);
        }
        Post();
    }

    private void Stop(string id)
    {
        if (_live.TryRemove(id, out var live))
        {
            live.Stop.Cancel();
        }
    }

    /// <summary>Keeps a computer's state connection open, connecting again after a while when it drops or can't be made.</summary>
    private void Keep(RemotePc pc)
    {
        var live = new Live();
        _live[pc.Id] = live;
        _ = Task.Run(async () =>
        {
            using var stop = CancellationTokenSource.CreateLinkedTokenSource(live.Stop.Token, _stop.Token);
            while (!stop.IsCancellationRequested)
            {
                await RunStateAsync(pc, live, stop.Token).ConfigureAwait(false);
                live.Online = false;
                Post();
                try
                {
                    await Task.Delay(RetryAfter, stop.Token).ConfigureAwait(false);
                }
                catch (OperationCanceledException)
                {
                    return;
                }
            }
        });
    }

    private async Task RunStateAsync(RemotePc pc, Live live, CancellationToken stop)
    {
        try
        {
            using var socket = await PcConnection.ConnectAsync(pc, stop).ConfigureAwait(false);
            live.Online = true;
            live.Error = null;
            Post();
            while (await PcConnection.ReceiveAsync(socket, stop).ConfigureAwait(false) is { } message)
            {
                if (message[Fields.Type]?.GetValue<string>() == Kinds.State && message[Fields.State] is { } state)
                {
                    live.State = state.ToJsonString();
                    Post();
                }
            }
            live.Error = "It closed the connection.";
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or System.Security.Authentication.AuthenticationException)
        {
            live.Error = stop.IsCancellationRequested ? null : "Can’t be reached now.";
        }
    }

    /// <summary>A terminal here opens one there: its own connection, watching it.</summary>
    private async Task WatchAsync(FromPage.PcWatch m)
    {
        Unwatch(m.Tab);
        if (store.List().FirstOrDefault(p => p.Id == m.Id) is not { } pc)
        {
            page.Post(new ToPage.PcRefused(m.Tab, "That computer isn’t paired any more."));
            return;
        }
        var stop = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        try
        {
            var socket = await PcConnection.ConnectAsync(pc, stop.Token).ConfigureAwait(false);
            var watch = new Watch(pc.Id, m.Pane, socket, new SemaphoreSlim(1, 1), stop);
            _watches[m.Tab] = watch;
            await PcConnection.SendAsync(socket, watch.Gate, new JsonObject { [Fields.Op] = Kinds.Watch, [Fields.Pane] = m.Pane, [Fields.Cols] = m.Cols, [Fields.Rows] = m.Rows }, stop.Token).ConfigureAwait(false);
            _ = Task.Run(() => ReadWatchAsync(m.Tab, pc, watch));
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or System.Security.Authentication.AuthenticationException)
        {
            stop.Dispose();
            page.Post(new ToPage.PcRefused(m.Tab, $"{pc.Name} can’t be reached now."));
        }
    }

    private async Task ReadWatchAsync(string tab, RemotePc pc, Watch watch)
    {
        try
        {
            while (await PcConnection.ReceiveAsync(watch.Socket, watch.Stop.Token).ConfigureAwait(false) is { } message)
            {
                var type = message[Fields.Type]?.GetValue<string>();
                if ((type == Kinds.Screen || type == Kinds.Output) && message[Fields.Pane]?.GetValue<string>() == watch.Pane)
                {
                    page.Post(new ToPage.PcOutput(tab, message[Fields.Data]?.GetValue<string>() ?? "", type == Kinds.Screen));
                }
                else if (type == Kinds.Answered && message[Fields.Ok]?.GetValue<bool>() == false)
                {
                    page.Post(new ToPage.PcRefused(tab, message[Fields.Error]?.GetValue<string>() ?? "That didn’t go through."));
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException)
        {
        }
        if (_watches.TryGetValue(tab, out var still) && still == watch)
        {
            page.Post(new ToPage.PcRefused(tab, $"Lost the connection to {pc.Name}."));
            Unwatch(tab);
        }
    }

    private void Unwatch(string tab)
    {
        if (_watches.TryRemove(tab, out var watch))
        {
            watch.Stop.Cancel();
            watch.Socket.Abort();
            watch.Socket.Dispose();
            watch.Stop.Dispose();
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

    /// <remarks>
    /// Registered as a handler and as a startable, so the container disposes it twice: the second time does nothing
    /// (cancelling a disposed token source threw, and every quit crashed).
    /// </remarks>
    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }
        _stop.Cancel();
        foreach (var tab in _watches.Keys.ToList())
        {
            Unwatch(tab);
        }
        _stop.Dispose();
    }
}
