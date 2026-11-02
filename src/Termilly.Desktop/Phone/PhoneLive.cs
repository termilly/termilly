using System.Collections.Concurrent;
using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

using Ops = Termilly.Desktop.Phone.LiveMessages.Ops;

namespace Termilly.Desktop.Phone;

/// <summary>
/// The paired phones that have the app open (docs/phone.md): one WebSocket each. Every phone gets what the page last
/// said about the terminals (js/phone.js) as soon as it connects and whenever it changes; what a phone sends (an
/// answer to an agent) goes to <see cref="Received"/>, and its answer back to that phone alone. A phone may watch one
/// terminal: it gets what that terminal shows (from the window), then what it prints, a few times a second. While
/// a phone watches a terminal, the terminal takes the phone's size (<see cref="Sized"/>), so it fills the phone and
/// its output fits it; it gets its own back when no phone watches it, when the phone gives its size up (a size of
/// nothing: another computer's terminal that isn't on its screen), or when the PC takes it back (<see cref="TakeBack"/>:
/// the phone is told, <see cref="Kinds.Released"/>, and has it again only by sending its size anew). One phone gives
/// it its size at a time: another sending its size takes it, and the one before is told the same way, with who has it.
/// </summary>
internal sealed class PhoneLive : IDisposable
{
    /// <summary>The longest message a phone may send: a reply to an agent.</summary>
    private const int MaxMessage = 16 * 1024;

    /// <summary>What a message to a phone is (its "type").</summary>
    public static class Kinds
    {
        public const string State = "state";
        public const string Answered = "answered";
        public const string Screen = "screen";
        public const string Output = "output";
        /// <summary>The PC took the terminal back: it has its own size again until this phone sends its size anew.</summary>
        public const string Released = "released";
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

    /// <summary>Who has a terminal open now (the phones' and computers' names), whenever that changes.</summary>
    public Action<string, IReadOnlyList<string>>? Watchers { get; set; }

    /// <summary>A paired phone's or computer's name, by its device id: who has a terminal now.</summary>
    public Func<string, string?>? NameOf { get; set; }

    /// <summary>The released message's field with who has the terminal now (none: the PC took it back).</summary>
    public const string ByField = "by";

    /// <summary>Who has a terminal when the one that took it isn't paired by a name known here.</summary>
    private const string SomeoneElse = "Another phone or computer";

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

    /// <summary>The state, with this computer's name: another Termilly computer lists it by that, not by its address.</summary>
    private string StateMessage() => $$"""{"{{TypeField}}":"{{Kinds.State}}","{{ComputerField}}":{{System.Text.Json.JsonSerializer.Serialize(Environment.MachineName)}},"{{StateField}}":{{_state}}}""";

    /// <summary>The state message's field with the computer's name.</summary>
    public const string ComputerField = "computer";

    /// <summary>Whether a paired phone has the app open on its screen now: its alerts would tell it what it sees.</summary>
    public bool IsOpenOn(string device) => _phones.Values.Any(p => p.Device == device && p.Shown);

    /// <summary>Whether a phone has this terminal on its screen now (the app open on it, the terminal shown).</summary>
    public bool IsShownOnPhone(string pane) => _phones.Values.Any(p => p.Watching == pane && p.Shown);

    /// <summary>A phone put a terminal on its screen (opened it, or came back to the app on it): its news is seen.</summary>
    public Action<string>? Opened { get; set; }

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
                var text = await LiveMessages.ReceiveAsync(socket, MaxMessage, stop).ConfigureAwait(false);
                if (text is null)
                {
                    break;
                }
                await HandleAsync(socket, me, LiveMessages.Parse(text)).ConfigureAwait(false);
            }
        }
        catch (Exception e) when (e is WebSocketException or OperationCanceledException or IOException or ObjectDisposedException)
        {
        }
        finally
        {
            Leave(me);
            _phones.TryRemove(socket, out var gone);
            Tell(me.Watching);
            gone?.Gate.Dispose();
            socket.Abort();
            socket.Dispose();
        }
    }

    /// <summary>One message from a phone: about the connection itself (watch, size, seen, refresh), or for <see cref="Received"/>.</summary>
    private async Task HandleAsync(WebSocket socket, Phone me, JsonObject? message)
    {
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
            Seen(me, message);
        }
        else if (op == Ops.Refresh && me.Watching is { } watched)
        {
            await SendScreenAsync(socket, me, watched).ConfigureAwait(false);
        }
        else if (Received is { } received && message is not null)
        {
            var answer = await received(me.Device, message).ConfigureAwait(false);
            answer[TypeField] = Kinds.Answered;
            await SendAsync(socket, answer.ToJsonString()).ConfigureAwait(false);
        }
    }

    /// <summary>The app came on the phone's screen or went to the background; back on a terminal, that's seen again.</summary>
    private void Seen(Phone phone, JsonObject? message)
    {
        var was = phone.Shown;
        phone.Shown = message?[ShownField]?.GetValue<bool>() ?? true;
        if (phone.Shown && !was && phone.Watching is { } pane)
        {
            Opened?.Invoke(pane);
        }
    }

    /// <summary>
    /// A phone watches a terminal (or none; <paramref name="watch"/> says which, and the phone's size for it): the
    /// terminal takes that size, the phone gets what it shows then, and from then on what it prints.
    /// </summary>
    private async Task WatchAsync(WebSocket socket, Phone phone, JsonObject? watch)
    {
        var pane = watch?[PaneField]?.GetValue<string>();
        var was = phone.Watching;
        if (was != pane)
        {
            Leave(phone);
        }
        phone.Ready = false;
        phone.Watching = pane;
        if (was != pane)
        {
            Tell(was);
            Tell(pane);
        }
        if (pane is null)
        {
            return;
        }
        Resize(phone, watch!);
        if (phone.Shown)
        {
            Opened?.Invoke(pane);
        }
        await SendScreenAsync(socket, phone, pane).ConfigureAwait(false);
    }

    /// <summary>
    /// What a terminal shows now, to the phone watching it (when it starts watching, and when it asks again), then what
    /// it prints from there.
    /// </summary>
    private async Task SendScreenAsync(WebSocket socket, Phone phone, string pane)
    {
        phone.Ready = false;
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

    /// <summary>
    /// The phone's size for the terminal it watches (from the size of its screen and its font); none (0) gives it up,
    /// still watching.
    /// </summary>
    private void Resize(Phone phone, JsonObject message)
    {
        if (phone.Watching is not { } pane || message[PaneField]?.GetValue<string>() != pane
            || message[ColsField]?.GetValue<int?>() is not { } cols || message[RowsField]?.GetValue<int?>() is not { } rows)
        {
            return;
        }
        if (cols <= 0 || rows <= 0)
        {
            Leave(phone);
            return;
        }
        var size = new GridSize(Math.Clamp(cols, MinCols, MaxCols), Math.Clamp(rows, MinRows, MaxRows));
        Release(pane, phone, NameOf?.Invoke(phone.Device) ?? SomeoneElse);
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

    /// <summary>
    /// The PC takes a terminal back: the phones and computers that gave it their size are told, and it has its own size
    /// again (until one of them sends its size anew).
    /// </summary>
    public void TakeBack(string pane)
    {
        if (Release(pane, null, null))
        {
            Sized?.Invoke(pane, null);
        }
    }

    /// <summary>Says who has a terminal open now (<see cref="Watchers"/>).</summary>
    private void Tell(string? pane)
    {
        if (pane is null || Watchers is not { } watchers)
        {
            return;
        }
        watchers(pane, _phones.Values.Where(p => p.Watching == pane).Select(p => NameOf?.Invoke(p.Device) ?? SomeoneElse).Distinct().Order(StringComparer.CurrentCultureIgnoreCase).ToList());
    }

    /// <summary>
    /// The phones and computers (but <paramref name="keeper"/>) that gave a terminal their size give it up, told who has
    /// it now (<paramref name="by"/>; none: the PC). Whether there were any.
    /// </summary>
    private bool Release(string pane, Phone? keeper, string? by)
    {
        var holders = _phones.Where(p => p.Value != keeper && p.Value.Watching == pane && p.Value.Size is not null).ToList();
        var message = new JsonObject { [TypeField] = Kinds.Released, [PaneField] = pane, [ByField] = by }.ToJsonString();
        foreach (var (socket, phone) in holders)
        {
            phone.Size = null;
            _ = SendAsync(socket, message);
        }
        return holders.Count > 0;
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
}
