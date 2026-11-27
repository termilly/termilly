using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using Fields = Termilly.Desktop.Features.PcWire.Fields;
using Kinds = Termilly.Desktop.Features.PcWire.Kinds;

namespace Termilly.Desktop.Features;

/// <summary>
/// Other Termilly computers (js/remotepc.js): pairing, and each one's live connection, kept open (again every few
/// seconds while it can't be reached) for what it shows and what's asked of it there. Its terminals opened here each
/// have a connection of their own (RemoteWatches). The other computer decides what's allowed (Settings › Phone ›
/// Allow typing there).
/// </summary>
internal sealed class RemotePcsHandler(PageChannel page, RemotePcStore store, Phone.PhoneStore phones, RemoteWatches watches)
    : IMessageHandler, IStartable, IDisposable
{
    private static readonly TimeSpan RetryAfter = TimeSpan.FromSeconds(10);
    /// <summary>How long a computer gets to answer what's asked of it.</summary>
    private static readonly TimeSpan AskFor = TimeSpan.FromSeconds(15);

    /// <summary>A computer's state connection: online or not, why, and the last state it sent.</summary>
    private sealed class Live
    {
        public CancellationTokenSource Stop { get; } = new();
        public volatile bool Online;
        public volatile string? Error;
        public volatile string? State;
        /// <summary>The connection while it's up, and what writes to it one at a time.</summary>
        public volatile ClientWebSocket? Socket;
        public SemaphoreSlim Gate { get; } = new(1, 1);
        /// <summary>One thing asked of the computer at a time, and its answer when it comes on the state connection.</summary>
        public SemaphoreSlim Asking { get; } = new(1, 1);
        public volatile TaskCompletionSource<JsonObject>? Answer;
    }

    private readonly ConcurrentDictionary<string, Live> _live = new();

    private readonly CancellationTokenSource _stop = new();
    private int _disposed;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.PcList>(_ => Post());
        router.On<FromPage.PcAdd>(AddAsync);
        router.On<FromPage.PcRemove>(m => Remove(m.Id));
        router.On<FromPage.PcManage>(ManageAsync);
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
            var pc = await PcConnection.PairAsync(address, m.Code, Environment.MachineName + PcConnection.ComputerMark, MyAuthority(), _stop.Token).ConfigureAwait(false);
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

    /// <summary>This computer's authority's fingerprint (made if it has none yet); null while it can't be read.</summary>
    private string? MyAuthority()
    {
        try
        {
            using var authority = phones.Authority(Environment.MachineName);
            return PcConnection.FingerprintOf(authority.RawData);
        }
        catch (Exception e) when (e is System.Security.Cryptography.CryptographicException or InvalidOperationException or IOException)
        {
            return null;
        }
    }

    private void Remove(string id)
    {
        Stop(id);
        store.Remove(id);
        watches.Forget(id);
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
            live.Socket = socket;
            live.Online = true;
            live.Error = null;
            Post();
            while (await PcConnection.ReceiveAsync(socket, stop).ConfigureAwait(false) is { } message)
            {
                var type = message[Fields.Type].AsText();
                if (type == Kinds.Answered && message[Fields.Op].AsText() == Kinds.Manage)
                {
                    live.Answer?.TrySetResult(message);
                }
                else if (type == Kinds.State && message[Fields.State] is { } state)
                {
                    live.State = state.ToJsonString();
                    if (message[Phone.PhoneLive.ComputerField].AsText() is { Length: > 0 } name && name != pc.Name)
                    {
                        // Its own name, not what the network called its address when it was paired.
                        pc = pc with { Name = name };
                        store.Add(pc);
                    }
                    Post();
                }
            }
            live.Error = "It closed the connection.";
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or System.Security.Authentication.AuthenticationException)
        {
            live.Error = stop.IsCancellationRequested ? null : "Can’t be reached now.";
        }
        catch (Exception e) when (e is not OutOfMemoryException)
        {
            CrashLog.Caught(e); // a bug: written down; the connection is tried again as after any loss
            live.Error = "Can’t be reached now.";
        }
        finally
        {
            live.Socket = null;
        }
    }

    /// <summary>Asks a computer to open or close something there. It says whether it may (its Settings › Remote).</summary>
    private async Task ManageAsync(FromPage.PcManage m)
    {
        page.Post(new ToPage.PcManaged(m.RequestId, await AskAsync(m).ConfigureAwait(false)));
    }

    /// <summary>
    /// What a computer's answer says went wrong, or null when it's done: done only when it says so (ok is true; every
    /// answer carries ok), so a missing or garbled ok is a failure, with its error or a general one.
    /// </summary>
    internal static string? ErrorOf(JsonObject answer) =>
        answer[Fields.Ok].AsBool() == true ? null : answer[Fields.Error].AsText() ?? "That didn’t go through.";

    /// <summary>The computer's error, or null when it's done.</summary>
    private async Task<string?> AskAsync(FromPage.PcManage m)
    {
        var name = store.List().FirstOrDefault(p => p.Id == m.Id)?.Name ?? "That computer";
        if (!_live.TryGetValue(m.Id, out var live) || live.Socket is not { } socket || JsonNode.Parse(m.Args.GetRawText()) is not JsonObject message)
        {
            return $"{name} can’t be reached now.";
        }
        message[Fields.Op] = Kinds.Manage;
        await live.Asking.WaitAsync(_stop.Token).ConfigureAwait(false);
        var answer = new TaskCompletionSource<JsonObject>(TaskCreationOptions.RunContinuationsAsynchronously);
        live.Answer = answer;
        try
        {
            await PcConnection.SendAsync(socket, live.Gate, message, _stop.Token).ConfigureAwait(false);
            var done = await answer.Task.WaitAsync(AskFor, _stop.Token).ConfigureAwait(false);
            return ErrorOf(done);
        }
        catch (Exception e) when (e is WebSocketException or IOException or OperationCanceledException or TimeoutException or ObjectDisposedException)
        {
            return $"{name} didn’t answer.";
        }
        finally
        {
            live.Answer = null;
            live.Asking.Release();
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
        _stop.Dispose();
    }
}
