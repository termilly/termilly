using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>
/// A terminal here showing another computer's terminal (remotepc.js): what happens while its connection is still being
/// made. The other computer is a WebSocket in this process, reached only once the test lets the connection through.
/// </summary>
public sealed class RemoteWatchTests : IDisposable
{
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(5);
    private static readonly TimeSpan Quiet = TimeSpan.FromMilliseconds(500);
    private const string Pc = "pc1";
    private const string Tab = "t1";

    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-remote-watch-").FullName;
    private readonly HeldConnector _connector = new();
    private readonly RemoteWatches _handler;
    private readonly MessageRouter _router = new(PageChannel.Json);

    public RemoteWatchTests()
    {
        var store = new RemotePcStore(Vault.Open(_dir));
        store.Add(new RemotePc(Pc, "Laptop", "127.0.0.1", "token", ""));
        _handler = new RemoteWatches(new PageChannel(new Sink()), store, null!, _connector);
        _handler.Register(_router);
    }

    public void Dispose()
    {
        _handler.Dispose();
        _connector.Dispose();
        Directory.Delete(_dir, recursive: true);
    }

    [Fact]
    public async Task A_remote_terminal_closed_while_it_connects_leaves_nothing_watching_there()
    {
        Page(new { type = "pc:watch", id = Pc, tab = Tab, pane = "p1", cols = 0, rows = 0 });
        await _connector.Asked.WaitAsync(Wait);
        Page(new { type = "pc:unwatch", tab = Tab });
        var other = await _connector.LetThroughAsync();

        // The other computer is never asked to show the terminal, and the connection ends.
        Assert.Null(await ReceiveOrEndAsync(other));
    }

    [Fact]
    public async Task A_size_given_while_connecting_reaches_the_other_computer()
    {
        Page(new { type = "pc:watch", id = Pc, tab = Tab, pane = "p1", cols = 0, rows = 0 });
        await _connector.Asked.WaitAsync(Wait);
        Page(new { type = "pc:size", tab = Tab, cols = 100, rows = 40 });
        var other = await _connector.LetThroughAsync();

        var sizes = new List<(int Cols, int Rows)>();
        while (await ReceiveOrEndAsync(other) is { } message)
        {
            sizes.Add(((int?)message["cols"] ?? 0, (int?)message["rows"] ?? 0));
            if (sizes[^1] == (100, 40))
            {
                break;
            }
        }
        Assert.Equal((100, 40), sizes.LastOrDefault());
    }

    private void Page(object message)
    {
        using var json = JsonDocument.Parse(JsonSerializer.Serialize(message));
        Assert.True(_router.Dispatch(json.RootElement, null));
    }

    /// <summary>The next message the other computer gets, or null once the connection ends or stays quiet.</summary>
    private static async Task<JsonObject?> ReceiveOrEndAsync(WebSocket other)
    {
        using var quiet = new CancellationTokenSource(Quiet);
        try
        {
            return await PcConnection.ReceiveAsync(other, quiet.Token);
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException)
        {
            return null;
        }
    }

    /// <summary>Connects to a WebSocket in this process, held until the test lets it through, cancelled or not.</summary>
    private sealed class HeldConnector : IPcConnector, IDisposable
    {
        private readonly TaskCompletionSource _through = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource _asked = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly TaskCompletionSource<WebSocket> _other = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly List<IDisposable> _held = [];

        public Task Asked => _asked.Task;

        public async Task<WebSocket> ConnectAsync(RemotePc pc, CancellationToken cancel)
        {
            _asked.TrySetResult();
            // Like a connection already made when the terminal closed: it completes whether or not it was cancelled.
            await _through.Task;
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var client = new TcpClient();
            await client.ConnectAsync(IPAddress.Loopback, ((IPEndPoint)listener.LocalEndpoint).Port, CancellationToken.None);
            var server = await listener.AcceptTcpClientAsync(CancellationToken.None);
            listener.Stop();
            _held.AddRange([client, server]);
            _other.TrySetResult(WebSocket.CreateFromStream(server.GetStream(), isServer: true, subProtocol: null, Timeout.InfiniteTimeSpan));
            return WebSocket.CreateFromStream(client.GetStream(), isServer: false, subProtocol: null, Timeout.InfiniteTimeSpan);
        }

        /// <summary>Lets the connection through; the other computer's end of it.</summary>
        public Task<WebSocket> LetThroughAsync()
        {
            _through.TrySetResult();
            return _other.Task.WaitAsync(Wait);
        }

        public void Dispose()
        {
            foreach (var held in _held)
            {
                held.Dispose();
            }
        }
    }

    private sealed class Sink : IPageSink
    {
        public void Send(string json)
        {
        }
    }
}
