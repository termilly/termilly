using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Phone;

/// <summary>
/// The paired phones that have the app open (docs/phone.md): one WebSocket each. Every phone gets what the page last
/// said about the terminals (js/phone.js) as soon as it connects and whenever it changes; what a phone sends (an
/// answer to an agent) goes to <see cref="Received"/>, and its answer back to that phone alone. A phone may watch one
/// terminal: it gets what that terminal printed lately (PhoneOutput), then what it prints, a few times a second.
/// </summary>
internal sealed class PhoneLive
{
    /// <summary>The longest message a phone may send: a reply to an agent.</summary>
    private const int MaxMessage = 16 * 1024;
    private const int ReceiveChunk = 4096;

    /// <summary>What a message to a phone is (its "type").</summary>
    public static class Kinds
    {
        public const string State = "state";
        public const string Answered = "answered";
        public const string Screen = "screen";
        public const string Output = "output";
    }

    /// <summary>What a phone asks of the connection itself: to watch a terminal, or stop.</summary>
    private static class Ops
    {
        public const string Watch = "watch";
        public const string Unwatch = "unwatch";
    }

    private const string OpField = "op";
    private const string PaneField = "pane";
    private const string DataField = "data";
    /// <summary>How often a watched terminal's new output goes out (a busy build prints thousands of times a second).</summary>
    private static readonly TimeSpan OutputEvery = TimeSpan.FromMilliseconds(40);

    /// <summary>A connected phone: one send at a time, and the terminal it watches.</summary>
    private sealed class Phone
    {
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public volatile string? Watching;
    }

    private const string TypeField = "type";
    private const string StateField = "state";

    private readonly ConcurrentDictionary<WebSocket, Phone> _phones = new();
    private readonly ConcurrentDictionary<string, StringBuilder> _pending = new();
    private readonly Timer _flush;
    private string _state = "{}";

    public PhoneLive() => _flush = new Timer(_ => Flush(), null, OutputEvery, OutputEvery);

    /// <summary>What a terminal printed lately, for a phone that starts watching it.</summary>
    public Func<string, string>? Recent { get; set; }

    /// <summary>A terminal printed something: it goes to the phones watching it with the next flush.</summary>
    public void Output(string pane, string data)
    {
        if (!_phones.Values.Any(p => p.Watching == pane))
        {
            return;
        }
        var pending = _pending.GetOrAdd(pane, _ => new StringBuilder());
        lock (pending)
        {
            pending.Append(data);
        }
    }

    private void Flush()
    {
        foreach (var (pane, pending) in _pending)
        {
            string data;
            lock (pending)
            {
                if (pending.Length == 0)
                {
                    continue;
                }
                data = pending.ToString();
                pending.Clear();
            }
            var message = new JsonObject { [TypeField] = Kinds.Output, [PaneField] = pane, [DataField] = data }.ToJsonString();
            foreach (var (socket, phone) in _phones)
            {
                if (phone.Watching == pane)
                {
                    _ = SendAsync(socket, message);
                }
            }
        }
    }

    /// <summary>A phone sent something: its device id and the message; the answer goes back to it.</summary>
    public Func<string, JsonObject, Task<JsonObject>>? Received { get; set; }

    /// <summary>How many phones have the app open now.</summary>
    public int Count => _phones.Count;

    /// <summary>The page's new picture of the terminals, for every phone.</summary>
    public void SetState(string stateJson)
    {
        _state = stateJson;
        var message = StateMessage();
        foreach (var phone in _phones.Keys)
        {
            _ = SendAsync(phone, message);
        }
    }

    private string StateMessage() => $$"""{"{{TypeField}}":"{{Kinds.State}}","{{StateField}}":{{_state}}}""";

    /// <summary>Serves one phone until it disconnects or the server stops.</summary>
    public async Task RunAsync(WebSocket socket, string device, CancellationToken stop)
    {
        var me = new Phone();
        _phones[socket] = me;
        try
        {
            await SendAsync(socket, StateMessage()).ConfigureAwait(false);
            while (socket.State == WebSocketState.Open && !stop.IsCancellationRequested)
            {
                var text = await ReceiveAsync(socket, stop).ConfigureAwait(false);
                if (text is null)
                {
                    break;
                }
                var message = Parse(text);
                var op = message?[OpField]?.GetValue<string>();
                if (op is Ops.Watch or Ops.Unwatch)
                {
                    await WatchAsync(socket, me, op == Ops.Watch ? message?[PaneField]?.GetValue<string>() : null).ConfigureAwait(false);
                }
                else if (Received is { } received && message is not null)
                {
                    var answer = await received(device, message).ConfigureAwait(false);
                    answer[TypeField] = Kinds.Answered;
                    await SendAsync(socket, answer.ToJsonString()).ConfigureAwait(false);
                }
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException or ObjectDisposedException)
        {
        }
        finally
        {
            _phones.TryRemove(socket, out var gone);
            gone?.Gate.Dispose();
            socket.Abort();
            socket.Dispose();
        }
    }

    /// <summary>A phone watches a terminal (or none): first what it printed lately, then what it prints.</summary>
    private async Task WatchAsync(WebSocket socket, Phone phone, string? pane)
    {
        phone.Watching = pane;
        if (pane is not null)
        {
            var screen = new JsonObject { [TypeField] = Kinds.Screen, [PaneField] = pane, [DataField] = Recent?.Invoke(pane) ?? "" };
            await SendAsync(socket, screen.ToJsonString()).ConfigureAwait(false);
        }
    }

    /// <summary>Closes every phone's connection (the server stops, or a phone was removed: it connects again or not).</summary>
    public void CloseAll()
    {
        foreach (var phone in _phones.Keys)
        {
            phone.Abort();
        }
    }

    private async Task SendAsync(WebSocket socket, string text)
    {
        if (!_phones.TryGetValue(socket, out var phone))
        {
            return;
        }
        try
        {
            await phone.Gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                phone.Gate.Release();
            }
        }
        catch (Exception e) when (e is WebSocketException or ObjectDisposedException or IOException)
        {
        }
    }

    /// <summary>One whole text message, or null when the phone went away or sent too much.</summary>
    private static async Task<string?> ReceiveAsync(WebSocket socket, CancellationToken stop)
    {
        var buffer = new byte[ReceiveChunk];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, stop).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close || message.Length + result.Count > MaxMessage)
            {
                return null;
            }
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return result.MessageType == WebSocketMessageType.Text ? Encoding.UTF8.GetString(message.ToArray()) : "";
            }
        }
    }

    private static JsonObject? Parse(string text)
    {
        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
