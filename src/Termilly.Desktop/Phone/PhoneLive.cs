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
/// answer to an agent) goes to <see cref="Received"/>, and its answer back to that phone alone.
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
    }

    private const string TypeField = "type";
    private const string StateField = "state";

    private readonly ConcurrentDictionary<WebSocket, SemaphoreSlim> _phones = new();
    private string _state = "{}";

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
        _phones[socket] = new SemaphoreSlim(1, 1);
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
                if (Received is { } received && Parse(text) is { } message)
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
            _phones.TryRemove(socket, out var gate);
            gate?.Dispose();
            socket.Abort();
            socket.Dispose();
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
        if (!_phones.TryGetValue(socket, out var gate))
        {
            return;
        }
        try
        {
            await gate.WaitAsync().ConfigureAwait(false);
            try
            {
                await socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None).ConfigureAwait(false);
            }
            finally
            {
                gate.Release();
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
