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
/// terminal: it gets what that terminal shows (from the window), then what it prints, a few times a second. While
/// a phone watches a terminal, the terminal takes the phone's size (<see cref="Sized"/>), so it fills the phone and
/// its output fits it; it gets its own back when no phone watches it.
/// </summary>
internal sealed class PhoneLive : IDisposable
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
        public const string Size = "size";
        /// <summary>The app came on screen or went to the background ({ shown }).</summary>
        public const string Seen = "seen";
    }

    private const string ShownField = "shown";

    private const string ColsField = "cols";
    private const string RowsField = "rows";
    /// <summary>The sizes a phone may ask for (a phone's screen, from tiny text on a tablet to big text on a phone).</summary>
    private const int MinCols = 20;
    private const int MaxCols = 400;
    private const int MinRows = 4;
    private const int MaxRows = 200;

    private const string OpField = "op";
    private const string PaneField = "pane";
    private const string DataField = "data";
    /// <summary>How often a watched terminal's new output goes out (a busy build prints thousands of times a second).</summary>
    private static readonly TimeSpan OutputEvery = TimeSpan.FromMilliseconds(40);

    /// <summary>
    /// A connected phone: one send at a time, the terminal it watches, and what that printed since the last flush. That
    /// waits while the phone gets what the terminal shows (<see cref="Ready"/> false), so it comes after it.
    /// </summary>
    private sealed class Phone(string device, string address)
    {
        public string Device => device;
        public string Address => address;
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public volatile string? Watching;
        public volatile bool Ready;
        public StringBuilder Pending { get; } = new();
        /// <summary>The size it asked for the terminal it watches, if it did.</summary>
        public volatile GridSize? Size;
        /// <summary>The app is on the phone's screen (connected means open, until it says it went to the background).</summary>
        public volatile bool Shown = true;
    }

    /// <summary>A terminal's size in characters.</summary>
    public sealed record GridSize(int Cols, int Rows);

    /// <summary>A phone watching a terminal: the size it asked for, which paired phone it is, and its address.</summary>
    public sealed record Viewer(GridSize Size, string Device, string Address);

    /// <summary>A terminal should take this phone's size, or (null) its own again: no phone watches it.</summary>
    public Action<string, Viewer?>? Sized { get; set; }

    private const string TypeField = "type";
    private const string StateField = "state";

    private readonly ConcurrentDictionary<WebSocket, Phone> _phones = new();
    private readonly Timer _flush;
    private string _state = "{}";

    public PhoneLive() => _flush = new Timer(_ => Flush(), null, OutputEvery, OutputEvery);

    /// <summary>
    /// What a terminal shows now, with its scrollback, as output that draws it again (js/phone.js), once it has taken
    /// the phone's size.
    /// </summary>
    public Func<string, Task<string>>? Screen { get; set; }

    /// <summary>A terminal printed something: it goes to the phones watching it with the next flush.</summary>
    public void Output(string pane, string data)
    {
        foreach (var phone in _phones.Values)
        {
            if (phone.Watching == pane)
            {
                lock (phone.Pending)
                {
                    phone.Pending.Append(data);
                }
            }
        }
    }

    private void Flush()
    {
        foreach (var (socket, phone) in _phones)
        {
            if (!phone.Ready || phone.Watching is not { } pane)
            {
                continue;
            }
            string data;
            lock (phone.Pending)
            {
                if (phone.Pending.Length == 0)
                {
                    continue;
                }
                data = phone.Pending.ToString();
                phone.Pending.Clear();
            }
            _ = SendAsync(socket, new JsonObject { [TypeField] = Kinds.Output, [PaneField] = pane, [DataField] = data }.ToJsonString());
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

    /// <summary>Whether a paired phone has the app open on its screen now: its alerts would tell it what it sees.</summary>
    public bool IsOpenOn(string device) => _phones.Values.Any(p => p.Device == device && p.Shown);

    /// <summary>Serves one phone until it disconnects or the server stops.</summary>
    public async Task RunAsync(WebSocket socket, string device, string address, CancellationToken stop)
    {
        var me = new Phone(device, address);
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
                    await WatchAsync(socket, me, op == Ops.Watch ? message : null).ConfigureAwait(false);
                }
                else if (op == Ops.Size)
                {
                    Resize(me, message!);
                }
                else if (op == Ops.Seen)
                {
                    me.Shown = message?[ShownField]?.GetValue<bool>() ?? true;
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
            Leave(me);
            _phones.TryRemove(socket, out var gone);
            gone?.Gate.Dispose();
            socket.Abort();
            socket.Dispose();
        }
    }

    /// <summary>
    /// A phone watches a terminal (or none; <paramref name="watch"/> says which, and the phone's size for it): the
    /// terminal takes that size, the phone gets what it shows then, and from then on what it prints.
    /// </summary>
    private async Task WatchAsync(WebSocket socket, Phone phone, JsonObject? watch)
    {
        var pane = watch?[PaneField]?.GetValue<string>();
        if (phone.Watching != pane)
        {
            Leave(phone);
        }
        phone.Ready = false;
        phone.Watching = pane;
        if (pane is null)
        {
            return;
        }
        Resize(phone, watch!);
        lock (phone.Pending)
        {
            phone.Pending.Clear(); // what the screen below has already
        }
        string data;
        try
        {
            data = Screen is { } screen ? await screen(pane).ConfigureAwait(false) : "";
        }
        catch (InvalidOperationException)
        {
            data = ""; // the window didn't answer: the phone starts empty, and gets what's printed from now
        }
        await SendAsync(socket, new JsonObject { [TypeField] = Kinds.Screen, [PaneField] = pane, [DataField] = data }.ToJsonString()).ConfigureAwait(false);
        phone.Ready = phone.Watching == pane;
    }

    /// <summary>The phone's size for the terminal it watches (from the size of its screen and its font).</summary>
    private void Resize(Phone phone, JsonObject message)
    {
        if (phone.Watching is not { } pane || message[PaneField]?.GetValue<string>() != pane
            || message[ColsField]?.GetValue<int?>() is not { } cols || message[RowsField]?.GetValue<int?>() is not { } rows)
        {
            return;
        }
        var size = new GridSize(Math.Clamp(cols, MinCols, MaxCols), Math.Clamp(rows, MinRows, MaxRows));
        phone.Size = size;
        Sized?.Invoke(pane, new Viewer(size, phone.Device, phone.Address));
    }

    /// <summary>
    /// A phone stops watching its terminal (another one, none, or it went away): the terminal takes the size of another
    /// phone still watching it, or its own again.
    /// </summary>
    private void Leave(Phone phone)
    {
        if (phone.Watching is not { } pane || phone.Size is null)
        {
            return;
        }
        phone.Size = null;
        var other = _phones.Values.FirstOrDefault(p => p != phone && p.Watching == pane && p.Size is not null);
        Sized?.Invoke(pane, other?.Size is { } size ? new Viewer(size, other.Device, other.Address) : null);
    }

    public void Dispose()
    {
        _flush.Dispose();
        CloseAll();
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
