using System.Collections.Concurrent;
using System.IO;
using System.Net;
using System.Net.NetworkInformation;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A pairing offered to a phone: its id and key, for the QR code.</summary>
internal readonly record struct PairingOffer(string Id, byte[] Key);

/// <summary>A message sealed for a phone: the nonce it was sealed with, and the ciphertext with its tag.</summary>
internal readonly record struct SealedMessage(byte[] Nonce, byte[] Sealed);

/// <summary>A paired phone as Settings shows it.</summary>
internal sealed record CheckinDevice(string Id, string Name, long Paired, long LastSeen);

/// <summary>
/// Phone check-in (docs/checkin.md): while Settings turns it on, a small web server on this PC's local network
/// address serves a page to phones and answers encrypted requests from paired ones: terminal states, recent output
/// (redacted), and, if allowed, Approve/Reject for an agent's permission prompt. Each phone has its own AES-256-GCM
/// key, handed over in a QR code's URL fragment, never over the network. Anything that isn't a valid request from a
/// paired phone gets an empty 403.
/// </summary>
internal sealed class CheckinServer : IDisposable
{
    public const int DefaultPort = 8765;
    private const int MaxBody = 64 * 1024;
    private static readonly TimeSpan Skew = TimeSpan.FromSeconds(60);
    /// <summary>How long one request may take, from connecting to the answer.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
    private const int ReadChunk = 8192;
    /// <summary>The longest request head (request line and headers) taken.</summary>
    private const int MaxHead = 16 * 1024;
    /// <summary>A request line's parts: method, path, version.</summary>
    private const int RequestLineParts = 3;
    private static readonly byte[] HeadEnd = "\r\n\r\n"u8.ToArray();
    private const string ApiPath = "/api";
    private const string IndexPage = "index.html";
    private const string ContentLength = "Content-Length";
    private const string UserAgent = "User-Agent";

    /// <summary>The private IPv4 ranges: 10.0.0.0/8, 172.16.0.0/12 and 192.168.0.0/16.</summary>
    private static class PrivateRanges
    {
        public const byte TenNet = 10;
        public const byte ClassB = 172;
        public const byte ClassBFrom = 16;
        public const byte ClassBTo = 31;
        public const byte ClassC = 192;
        public const byte ClassCSecond = 168;
    }

    /// <summary>The phone page's file types, by extension.</summary>
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase) {
        [MediaTypes.Extensions.Html] = MediaTypes.Utf8(MediaTypes.Html), [MediaTypes.Extensions.JavaScript] = MediaTypes.Utf8(MediaTypes.JavaScript),
        [MediaTypes.Extensions.Css] = MediaTypes.Utf8(MediaTypes.Css), [MediaTypes.Extensions.Svg] = MediaTypes.Svg,
        [MediaTypes.Extensions.Json] = MediaTypes.Manifest, [MediaTypes.Extensions.Manifest] = MediaTypes.Manifest,
    };

    /// <summary>The reason phrase for each status sent.</summary>
    private static readonly Dictionary<HttpStatusCode, string> Reasons = new() {
        [HttpStatusCode.OK] = "OK", [HttpStatusCode.Forbidden] = "Forbidden", [HttpStatusCode.NotFound] = "Not Found",
        [HttpStatusCode.MethodNotAllowed] = "Method Not Allowed",
    };
    /// <summary>AES-GCM's 96-bit nonce and 128-bit tag, as the phone page uses them.</summary>
    private const int NonceSize = 12;
    private const int TagSize = 16;

    /// <summary>Answers an operation from a phone: "state", "output" or "answer" with its arguments.</summary>
    public delegate Task<JsonNode?> Operation(string op, JsonObject args);

    private readonly TcpListener _listener;
    private readonly string _webRoot;
    private readonly Operation _operation;
    private readonly CheckinDevices _devices;
    private readonly CancellationTokenSource _stop = new();

    public string BaseUrl { get; }

    private CheckinServer(IPAddress address, int port, string webRoot, Operation operation, CheckinDevices devices)
    {
        _devices = devices;
        _webRoot = Path.GetFullPath(webRoot);
        _operation = operation;
        _listener = new TcpListener(address, port);
        _listener.Start();
        BaseUrl = $"http://{address}:{((IPEndPoint)_listener.LocalEndpoint).Port}/";
        _ = Task.Run(AcceptLoop);
    }

    /// <summary>Starts listening on the local network address (TERMILLY_CHECKIN_BIND overrides it, for tests).</summary>
    public static CheckinServer Start(int port, string webRoot, Operation operation, CheckinDevices devices)
    {
        var address = Environment.GetEnvironmentVariable("TERMILLY_CHECKIN_BIND") is { Length: > 0 } bind
            ? IPAddress.Parse(bind)
            : LocalNetworkAddress() ?? throw new IOException("This PC isn't on a local network (no 10.x, 172.16–31.x or 192.168.x address).");
        try
        {
            return new CheckinServer(address, port, webRoot, operation, devices);
        }
        catch (SocketException e)
        {
            throw new IOException($"Port {port} can't be used: {e.Message}");
        }
    }

    /// <summary>The PC's private IPv4 address on a connected network: never a public one.</summary>
    public static IPAddress? LocalNetworkAddress() =>
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .OrderBy(n => n.GetIPProperties().GatewayAddresses.Count == 0) // the one with a router first
            .SelectMany(n => n.GetIPProperties().UnicastAddresses.Select(a => a.Address))
            .FirstOrDefault(IsPrivate);

    public static bool IsPrivate(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }
        var b = address.GetAddressBytes();
        return b[0] == PrivateRanges.TenNet || (b[0] == PrivateRanges.ClassB && b[1] is >= PrivateRanges.ClassBFrom and <= PrivateRanges.ClassBTo) ||
               (b[0] == PrivateRanges.ClassC && b[1] == PrivateRanges.ClassCSecond);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
    }

    private async Task AcceptLoop()
    {
        while (!_stop.IsCancellationRequested)
        {
            TcpClient client;
            try
            {
                client = await _listener.AcceptTcpClientAsync(_stop.Token);
            }
            catch (Exception) when (_stop.IsCancellationRequested)
            {
                return;
            }
            catch (SocketException)
            {
                continue;
            }
            _ = Task.Run(() => Serve(client));
        }
    }

    // ---- HTTP (just enough: one request per connection) ----

    private async Task Serve(TcpClient client)
    {
        using var _ = client;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(_stop.Token);
        timeout.CancelAfter(RequestTimeout);
        try
        {
            var stream = client.GetStream();
            var (method, path, headers, body) = await ReadRequest(stream, timeout.Token);
            var (status, type, content, extra) = await Respond(method, path, headers, body);
            await WriteResponse(stream, status, type, content, extra, timeout.Token);
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or SocketException or FormatException)
        {
        }
    }

    private static async Task<(string Method, string Path, Dictionary<string, string> Headers, byte[] Body)> ReadRequest(Stream stream, CancellationToken cancel)
    {
        var buffer = new MemoryStream();
        var chunk = new byte[ReadChunk];
        int headerEnd;
        while ((headerEnd = IndexOf(buffer.GetBuffer().AsSpan(0, (int)buffer.Length), HeadEnd)) < 0)
        {
            var read = await stream.ReadAsync(chunk, cancel);
            if (read == 0 || buffer.Length > MaxHead)
            {
                throw new FormatException("bad request");
            }
            buffer.Write(chunk, 0, read);
        }
        var head = Encoding.ASCII.GetString(buffer.GetBuffer(), 0, headerEnd).Split("\r\n");
        var start = head[0].Split(' ');
        if (start.Length < RequestLineParts)
        {
            throw new FormatException("bad request line");
        }
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in head.Skip(1))
        {
            var colon = line.IndexOf(':');
            if (colon > 0)
            {
                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
        }
        var length = headers.TryGetValue(ContentLength, out var l) && int.TryParse(l, out var n) ? n : 0;
        if (length is < 0 or > MaxBody)
        {
            throw new FormatException("too large");
        }
        var body = new byte[length];
        var have = (int)buffer.Length - headerEnd - HeadEnd.Length;
        Array.Copy(buffer.GetBuffer(), headerEnd + HeadEnd.Length, body, 0, Math.Min(have, length));
        while (have < length)
        {
            var read = await stream.ReadAsync(body.AsMemory(have, length - have), cancel);
            if (read == 0)
            {
                throw new FormatException("short body");
            }
            have += read;
        }
        return (start[0], start[1], headers, body);
    }

    private static int IndexOf(ReadOnlySpan<byte> data, ReadOnlySpan<byte> value) => data.IndexOf(value);

    private static async Task WriteResponse(Stream stream, HttpStatusCode status, string type, byte[] content, string extra, CancellationToken cancel)
    {
        var reason = Reasons.GetValueOrDefault(status, "Error");
        var head = $"HTTP/1.1 {(int)status} {reason}\r\nContent-Type: {type}\r\nContent-Length: {content.Length}\r\n" +
                   "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n" +
                   $"{extra}Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head), cancel);
        await stream.WriteAsync(content, cancel);
    }

    private const string PageSecurity =
        "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n";

    private async Task<(HttpStatusCode Status, string Type, byte[] Content, string Extra)> Respond(string method, string path, Dictionary<string, string> headers, byte[] body)
    {
        var forbidden = (HttpStatusCode.Forbidden, MediaTypes.PlainText, Array.Empty<byte>(), "");
        path = path.Split('?')[0];
        if (path == ApiPath)
        {
            if (method != System.Net.Http.HttpMethod.Post.Method)
            {
                return forbidden;
            }
            var answer = await HandleApi(Encoding.UTF8.GetString(body), headers.GetValueOrDefault(UserAgent));
            return answer is null ? forbidden : (HttpStatusCode.OK, MediaTypes.Json, Encoding.UTF8.GetBytes(answer), "");
        }
        if (method != System.Net.Http.HttpMethod.Get.Method)
        {
            return (HttpStatusCode.MethodNotAllowed, MediaTypes.PlainText, [], "");
        }
        // Static files of the phone page, from wwwroot\phone only.
        var relative = path == "/" ? IndexPage : Uri.UnescapeDataString(path.TrimStart('/'));
        var file = Path.GetFullPath(Path.Combine(_webRoot, relative));
        if (!file.StartsWith(_webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
        {
            return (HttpStatusCode.NotFound, MediaTypes.PlainText, [], "");
        }
        var type = Types.GetValueOrDefault(Path.GetExtension(file), MediaTypes.Binary);
        return (HttpStatusCode.OK, type, await File.ReadAllBytesAsync(file), PageSecurity);
    }

    // ---- Encrypted API ----

    private readonly ConcurrentDictionary<string, ConcurrentDictionary<string, long>> _nonces = new();

    /// <summary>
    /// One request: { d: phone id, n: nonce, c: ciphertext } sealed with the phone's key (aad: its id), holding
    /// { t: time, op, ...args }. Returns the sealed answer, or null for anything that doesn't check out.
    /// </summary>
    public async Task<string?> HandleApi(string body, string? userAgent)
    {
        if (ReadEnvelope(body) is not (var id, var nonce, var sealedBytes) || _devices.KeyFor(id) is not { } key ||
            nonce.Length != NonceSize || sealedBytes.Length < TagSize ||
            Unseal(key, nonce, sealedBytes, id) is not { } message || !IsFresh(message, id, nonce))
        {
            return null;
        }
        _devices.Seen(id, userAgent);

        JsonNode? result;
        try
        {
            var op = message[Fields.Operation]?.GetValue<string>() ?? "";
            result = new JsonObject { [Fields.Ok] = true, [Fields.Result] = await _operation(op, message) };
        }
        catch (Exception e) when (e is InvalidOperationException or IOException)
        {
            result = new JsonObject { [Fields.Ok] = false, [Fields.Error] = e.Message };
        }
        var (replyNonce, reply) = Seal(key, result!.ToJsonString(), id);
        return new JsonObject { [Fields.Nonce] = Convert.ToBase64String(replyNonce), [Fields.Sealed] = Convert.ToBase64String(reply) }.ToJsonString();
    }

    /// <summary>The fields of a phone's requests and the answers to them (phone/phone.js).</summary>
    private static class Fields
    {
        public const string Device = "d";
        public const string Nonce = "n";
        public const string Sealed = "c";
        public const string Time = "t";
        public const string Operation = "op";
        public const string Ok = "ok";
        public const string Result = "result";
        public const string Error = "error";
    }

    /// <summary>A request's phone id, nonce and sealed message; null when it doesn't read.</summary>
    private static (string Id, byte[] Nonce, byte[] Sealed)? ReadEnvelope(string body)
    {
        try
        {
            var request = JsonNode.Parse(body) as JsonObject;
            return (request?[Fields.Device]?.GetValue<string>() ?? "",
                Convert.FromBase64String(request?[Fields.Nonce]?.GetValue<string>() ?? ""),
                Convert.FromBase64String(request?[Fields.Sealed]?.GetValue<string>() ?? ""));
        }
        catch (Exception e) when (e is JsonException or FormatException or InvalidOperationException)
        {
            return null;
        }
    }

    /// <summary>The message inside, opened with the phone's key; null when it doesn't open (a wrong key, a changed message).</summary>
    private static JsonObject? Unseal(byte[] key, byte[] nonce, byte[] sealedBytes, string id)
    {
        try
        {
            return JsonNode.Parse(Open(key, nonce, sealedBytes, id)) as JsonObject;
        }
        catch (Exception e) when (e is CryptographicException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Sent just now (within the clock skew allowed), and not seen before: an old or replayed request isn't answered.</summary>
    private bool IsFresh(JsonObject message, string id, byte[] nonce)
    {
        var sent = message[Fields.Time] is JsonValue t && t.TryGetValue<long>(out var ms) ? ms : 0;
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (Math.Abs(now - sent) > Skew.TotalMilliseconds)
        {
            return false;
        }
        var seen = _nonces.GetOrAdd(id, _ => new());
        if (!seen.TryAdd(Convert.ToBase64String(nonce), now))
        {
            return false; // a replay
        }
        foreach (var old in seen.Where(kv => now - kv.Value > Skew.TotalMilliseconds * 2).Select(kv => kv.Key).ToList())
        {
            seen.TryRemove(old, out _);
        }
        return true;
    }

    /// <summary>AES-256-GCM as the phone page does it (noble): ciphertext with the 16-byte tag at the end.</summary>
    public static SealedMessage Seal(byte[] key, string plaintext, string aad)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var data = Encoding.UTF8.GetBytes(plaintext);
        var output = new byte[data.Length + TagSize];
        using var gcm = new AesGcm(key, TagSize);
        gcm.Encrypt(nonce, data, output.AsSpan(0, data.Length), output.AsSpan(data.Length), Encoding.UTF8.GetBytes(aad));
        return new(nonce, output);
    }

    public static string Open(byte[] key, byte[] nonce, byte[] sealedBytes, string aad)
    {
        var plaintext = new byte[sealedBytes.Length - TagSize];
        using var gcm = new AesGcm(key, TagSize);
        gcm.Decrypt(nonce, sealedBytes.AsSpan(0, plaintext.Length), sealedBytes.AsSpan(plaintext.Length), plaintext, Encoding.UTF8.GetBytes(aad));
        return Encoding.UTF8.GetString(plaintext);
    }
}

/// <summary>
/// The paired phones and their keys, in checkin.json next to keys.json, each key sealed with the vault key. A
/// pairing offered in Settings waits in memory for 5 minutes; the phone's first valid request makes it paired.
/// </summary>
internal sealed class CheckinDevices(Vault vault)
{
    /// <summary>How long a pairing offered in Settings waits for the phone.</summary>
    private static readonly TimeSpan PairingLifetime = TimeSpan.FromMinutes(5);
    /// <summary>"Last seen" is written at most this often (phones ask every few seconds).</summary>
    private static readonly TimeSpan SeenEvery = TimeSpan.FromMinutes(1);
    private const int IdBytes = 8;
    /// <summary>AES-256's key.</summary>
    private const int KeyBytes = 32;
    private const string DevicesFile = "checkin.json";
    private const string IPhone = "iPhone";
    private const string IPad = "iPad";

    private readonly Lock _gate = new();
    private readonly Dictionary<string, (byte[] Key, DateTime Expires)> _pending = [];
    private List<Stored>? _devices;

    private sealed record Stored(string Id, string Name, string Key, long Paired, long LastSeen);

    private string FilePath => vault.PathOf(DevicesFile);

    public event Action? Changed;

    /// <summary>A new pairing: the phone id and key for the QR code.</summary>
    public PairingOffer Offer()
    {
        lock (_gate)
        {
            foreach (var expired in _pending.Where(p => p.Value.Expires < DateTime.UtcNow).Select(p => p.Key).ToList())
            {
                _pending.Remove(expired);
            }
            var id = Convert.ToHexString(RandomNumberGenerator.GetBytes(IdBytes)).ToLowerInvariant();
            var key = RandomNumberGenerator.GetBytes(KeyBytes);
            _pending[id] = (key, DateTime.UtcNow + PairingLifetime);
            return new(id, key);
        }
    }

    public byte[]? KeyFor(string id)
    {
        lock (_gate)
        {
            if (Load().FirstOrDefault(d => d.Id == id) is { } device && vault.Key is { } vaultKey)
            {
                try
                {
                    return Sealed.Open(vaultKey, Convert.FromBase64String(device.Key));
                }
                catch (CryptographicException)
                {
                    return null;
                }
            }
            return _pending.TryGetValue(id, out var pending) && pending.Expires > DateTime.UtcNow ? pending.Key : null;
        }
    }

    /// <summary>A valid request came from this phone: a pending pairing becomes a paired phone, named after its browser.</summary>
    public void Seen(string id, string? userAgent)
    {
        var changed = false;
        lock (_gate)
        {
            var devices = Load();
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var index = devices.FindIndex(d => d.Id == id);
            if (index >= 0)
            {
                // Phones ask every few seconds: "last seen" is written at most once a minute.
                if (now - devices[index].LastSeen < SeenEvery.TotalMilliseconds)
                {
                    return;
                }
                devices[index] = devices[index] with { LastSeen = now };
            }
            else if (_pending.Remove(id, out var pending) && vault.Key is { } vaultKey)
            {
                devices.Add(new Stored(id, NameFrom(userAgent), Convert.ToBase64String(Sealed.Seal(vaultKey, pending.Key)), now, now));
                changed = true;
            }
            Save(devices);
        }
        if (changed)
        {
            Changed?.Invoke();
        }
    }

    public static string NameFrom(string? userAgent) => userAgent switch
    {
        null => "Phone",
        _ when userAgent.Contains(IPhone) => IPhone,
        _ when userAgent.Contains(IPad) => IPad,
        _ when userAgent.Contains("Android") => "Android phone",
        _ => "Browser",
    };

    public List<CheckinDevice> List()
    {
        lock (_gate)
        {
            return Load().Select(d => new CheckinDevice(d.Id, d.Name, d.Paired, d.LastSeen)).ToList();
        }
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            var devices = Load();
            devices.RemoveAll(d => d.Id == id);
            _pending.Remove(id);
            Save(devices);
        }
    }

    /// <summary>Forgets what's in memory (tests, or after the vault changed).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _devices = null;
            _pending.Clear();
        }
    }

    private List<Stored> Load()
    {
        if (_devices is not null)
        {
            return _devices;
        }
        try
        {
            _devices = File.Exists(FilePath) ? JsonSerializer.Deserialize<List<Stored>>(File.ReadAllText(FilePath)) ?? [] : [];
        }
        catch (Exception e) when (e is IOException or JsonException)
        {
            _devices = [];
        }
        return _devices;
    }

    private void Save(List<Stored> devices) => AppPaths.WriteAtomically(FilePath, JsonSerializer.Serialize(devices));
}
