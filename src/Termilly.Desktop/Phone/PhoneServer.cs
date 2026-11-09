using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.NetworkInformation;
using System.Net.Security;
using System.Net.Sockets;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Authentication;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Termilly on a phone (docs/phone.md): while Settings turns it on, a small server on this PC's local network
/// address. One port takes both:
/// <list type="bullet">
/// <item>plain http, for a phone that doesn't trust Termilly yet: the setup page and Termilly's certificate, nothing else;</item>
/// <item>HTTPS (a certificate from Termilly's own authority, PhoneCertificates): the phone app, and its API for paired phones.</item>
/// </list>
/// Paired phones get the app's API (PhoneAppApi); anything else gets 403.
/// </summary>
internal sealed class PhoneServer : IDisposable
{
    private const int MaxBody = 16 * 1024;
    private const int MaxHead = 16 * 1024;
    private const int ReadChunk = 8192;
    private const int RequestLineParts = 3;
    /// <summary>How long one request may take, from connecting to the answer.</summary>
    private static readonly TimeSpan RequestTimeout = TimeSpan.FromSeconds(15);
    private static readonly byte[] HeadEnd = "\r\n\r\n"u8.ToArray();
    /// <summary>The first byte of a TLS handshake: anything else is plain http.</summary>
    private const byte TlsHandshake = 0x16;
    /// <summary>Where a paired phone opens its live connection (PhoneLive), and how often it's kept alive.</summary>
    private const string LivePath = "/api/live";
    private static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(20);
    /// <summary>RFC 6455's fixed text, hashed with the phone's key to accept its WebSocket.</summary>
    private const string WebSocketGuid = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    private const string IndexPage = "index.html";
    private const string SetupPage = "setup.html";
    /// <summary>What the plain-http side serves: the setup page, its script and style, and the certificate.</summary>
    private static readonly string[] SetupFiles = [SetupPage, "setup.js", "phone.css"];
    private const string CertificatePath = "/termilly.cer";
    private const string CertificateType = "application/x-x509-ca-cert";

    /// <summary>The private IPv4 ranges (10/8, 172.16/12, 192.168/16) and the shared range VPNs like Tailscale use (100.64/10).</summary>
    private static class PrivateRanges
    {
        public const byte TenNet = 10;
        public const byte ClassB = 172;
        public const byte ClassBFrom = 16;
        public const byte ClassBTo = 31;
        public const byte ClassC = 192;
        public const byte ClassCSecond = 168;
        public const byte Shared = 100;
        public const byte SharedFrom = 64;
        public const byte SharedTo = 127;
        /// <summary>169.254.x: an address a network adapter gave itself, reaching nothing.</summary>
        public const byte LinkLocal = 169;
        public const byte LinkLocalSecond = 254;
    }

    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase)
    {
        [MediaTypes.Extensions.Html] = MediaTypes.Utf8(MediaTypes.Html), [MediaTypes.Extensions.JavaScript] = MediaTypes.Utf8(MediaTypes.JavaScript),
        [MediaTypes.Extensions.Css] = MediaTypes.Utf8(MediaTypes.Css), [MediaTypes.Extensions.Svg] = MediaTypes.Svg,
        [MediaTypes.Extensions.Png] = MediaTypes.Png, [MediaTypes.Extensions.Manifest] = MediaTypes.Manifest,
    };

    private static readonly Dictionary<HttpStatusCode, string> Reasons = new()
    {
        [HttpStatusCode.OK] = "OK", [HttpStatusCode.Forbidden] = "Forbidden", [HttpStatusCode.NotFound] = "Not Found",
        [HttpStatusCode.MethodNotAllowed] = "Method Not Allowed", [HttpStatusCode.BadRequest] = "Bad Request",
    };

    private const string PageSecurity =
        "Content-Security-Policy: default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\n";

    private readonly TcpListener _listener;
    private readonly string _webRoot;
    private readonly PhoneAppApi _api;
    private readonly PhoneLive _live;
    private readonly X509Certificate2 _certificate;
    private readonly byte[] _authorityFile;
    private readonly CancellationTokenSource _stop = new();

    /// <summary>
    /// Connections served at once, at most: each phone or computer keeps one live connection and opens a few for
    /// requests, so this is far above real use, and a flood of connections can't start a task each without end.
    /// </summary>
    internal const int MaxConnections = 64;
    private readonly ConnectionLimit _connections = new(MaxConnections);

    /// <summary>The setup page (plain http) and the app (HTTPS), at this PC's address.</summary>
    public string SetupUrl { get; }
    public string AppUrl { get; }

    /// <summary>Another Termilly computer's Copy to (PcFilesApi); null where nothing takes it.</summary>
    private readonly PcFilesApi? _files;
    /// <summary>Another Termilly computer's Prompt history (PcPromptsApi); null where nothing takes it.</summary>
    private readonly PcPromptsApi? _prompts;

    private PhoneServer(IPAddress address, int port, string webRoot, PhoneStore store, PhoneLive live, X509Certificate2 authority, string pushKey,
        Func<string, Task> testAlert, PcFilesApi? files, Func<string, string?>? attachedTo, PcPromptsApi? prompts)
    {
        (_webRoot, _api, _live, _files, _prompts) = (Path.GetFullPath(webRoot), new PhoneAppApi(store, pushKey, testAlert, BuildOf(webRoot), attachedTo), live, files, prompts);
        _certificate = store.ServerCertificate(authority, [address], HostName);
        _authorityFile = PhoneCertificates.AuthorityFile(authority);
        _listener = new TcpListener(address, port);
        _listener.Start();
        var bound = ((IPEndPoint)_listener.LocalEndpoint).Port;
        (SetupUrl, AppUrl) = ($"http://{address}:{bound}/", $"https://{address}:{bound}/");
        _ = Task.Run(AcceptLoop);
    }

    /// <summary>This PC on the local network by name (mDNS), also in the certificate.</summary>
    private static string HostName => $"{Dns.GetHostName().ToLowerInvariant()}.local";

    /// <summary>Starts on the local network address (TERMILLY_PHONE_BIND overrides it, for tests). IOException when it can't.</summary>
    /// <summary>The app's build: the newest of its files' times, so a rebuilt app is a new one.</summary>
    private static string BuildOf(string webRoot) => Directory.Exists(webRoot)
        ? Directory.EnumerateFiles(webRoot, "*", SearchOption.AllDirectories).Select(File.GetLastWriteTimeUtc).DefaultIfEmpty().Max().Ticks.ToString("x", System.Globalization.CultureInfo.InvariantCulture)
        : "";

    public static PhoneServer Start(int port, string webRoot, PhoneStore store, PhoneLive live, X509Certificate2 authority, string pushKey, Func<string, Task> testAlert,
        PcFilesApi? files = null, Func<string, string?>? attachedTo = null, PcPromptsApi? prompts = null)
    {
        var address = Environment.GetEnvironmentVariable("TERMILLY_PHONE_BIND") is { Length: > 0 } bind
            ? IPAddress.Parse(bind)
            : LocalNetworkAddress() ?? throw new IOException("This PC has no network address to listen on.");
        try
        {
            return new PhoneServer(address, port, webRoot, store, live, authority, pushKey, testAlert, files, attachedTo, prompts);
        }
        catch (SocketException e)
        {
            throw new IOException($"Port {port} can't be used: {e.Message}");
        }
    }

    /// <summary>The PC's private IPv4 address on a connected network (the one with a router first); never a public one.</summary>
    public static IPAddress? LocalNetworkAddress() => Pick(
        NetworkInterface.GetAllNetworkInterfaces()
            .Where(n => n.OperationalStatus == OperationalStatus.Up && n.NetworkInterfaceType != NetworkInterfaceType.Loopback)
            .OrderBy(n => n.GetIPProperties().GatewayAddresses.Count == 0)
            .SelectMany(n => n.GetIPProperties().UnicastAddresses.Select(a => a.Address)));

    /// <summary>
    /// The address to listen on: the first private one, else the first of any other. A cloud machine's network can use
    /// any subnet, or have a public address only.
    /// </summary>
    internal static IPAddress? Pick(IEnumerable<IPAddress> addresses)
    {
        var usable = addresses.Where(IsUsable).ToList();
        return usable.Find(IsPrivate) ?? usable.FirstOrDefault();
    }

    private static bool IsUsable(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address))
        {
            return false;
        }
        var b = address.GetAddressBytes();
        return b[0] != PrivateRanges.LinkLocal || b[1] != PrivateRanges.LinkLocalSecond;
    }

    public static bool IsPrivate(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }
        var b = address.GetAddressBytes();
        return b[0] == PrivateRanges.TenNet || (b[0] == PrivateRanges.ClassB && b[1] is >= PrivateRanges.ClassBFrom and <= PrivateRanges.ClassBTo) ||
               (b[0] == PrivateRanges.ClassC && b[1] == PrivateRanges.ClassCSecond) ||
               (b[0] == PrivateRanges.Shared && b[1] is >= PrivateRanges.SharedFrom and <= PrivateRanges.SharedTo);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        _certificate.Dispose();
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
            // All taken: this one is closed at once (a real client tries again; a flood gets nothing).
            if (!_connections.TryStart(() => Serve(client)))
            {
                client.Dispose();
            }
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
            var first = new byte[1];
            if (await client.Client.ReceiveAsync(first, SocketFlags.Peek, timeout.Token) == 0)
            {
                return;
            }
            Stream stream = client.GetStream();
            var secure = first[0] == TlsHandshake;
            if (secure)
            {
                var tls = new SslStream(stream, false);
                await tls.AuthenticateAsServerAsync(new SslServerAuthenticationOptions
                {
                    ServerCertificate = _certificate,
                    EnabledSslProtocols = SslProtocols.Tls12 | SslProtocols.Tls13,
                }, timeout.Token);
                stream = tls;
            }
            await using (stream)
            {
                var request = await ReadRequest(stream, timeout.Token);
                if (secure && request.Path == LivePath && request.Headers.TryGetValue("Sec-WebSocket-Key", out var key))
                {
                    await ServeLive(stream, request, key, (client.Client.RemoteEndPoint as IPEndPoint)?.Address.MapToIPv4().ToString() ?? "", timeout.Token);
                    return;
                }
                if (request.Path == PcFiles.Put)
                {
                    // Its body can be large and slow: read here, not with the request, and not within its time.
                    var taken = secure && _files is not null && request.Method == HttpMethod.Put.Method && _api.DeviceOf(request) is not null
                        ? await _files.UploadAsync(request, stream, _stop.Token)
                        : Forbidden;
                    await WriteResponse(stream, taken, _stop.Token);
                    return;
                }
                var reply = secure ? await RespondSecure(request) : await RespondPlain(request);
                await WriteResponse(stream, reply, timeout.Token);
            }
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or SocketException or FormatException or AuthenticationException)
        {
        }
    }

    /// <summary>A paired phone's live connection (RFC 6455): accepted, then PhoneLive serves it until it closes.</summary>
    private async Task ServeLive(Stream stream, PhoneRequest request, string key, string address, CancellationToken cancel)
    {
        if (_api.DeviceOf(request) is not { } device)
        {
            await WriteResponse(stream, Forbidden, cancel);
            return;
        }
#pragma warning disable CA5350 // RFC 6455 names SHA-1 for the handshake; it proves nothing secret, TLS does that
        var accept = Convert.ToBase64String(SHA1.HashData(Encoding.ASCII.GetBytes(key + WebSocketGuid)));
#pragma warning restore CA5350
        await stream.WriteAsync(Encoding.ASCII.GetBytes($"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: {accept}\r\n\r\n"), cancel);
        await stream.FlushAsync(cancel);
        var socket = WebSocket.CreateFromStream(stream, new WebSocketCreationOptions { IsServer = true, KeepAliveInterval = KeepAlive });
        await _live.RunAsync(socket, device, address, _stop.Token);
    }

    private static async Task<PhoneRequest> ReadRequest(Stream stream, CancellationToken cancel)
    {
        var buffer = new MemoryStream();
        var chunk = new byte[ReadChunk];
        int headerEnd;
        while ((headerEnd = buffer.GetBuffer().AsSpan(0, (int)buffer.Length).IndexOf(HeadEnd)) < 0)
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
        var headers = HeadersOf(head.Skip(1));
        var path = start[1].Split('?')[0];
        if (path == PcFiles.Put)
        {
            // An upload's body is streamed to a file (PcFilesApi): only what came with the head is passed on here.
            var extra = buffer.GetBuffer().AsSpan(headerEnd + HeadEnd.Length, (int)buffer.Length - headerEnd - HeadEnd.Length).ToArray();
            return new PhoneRequest(start[0], path, headers, extra);
        }
        var length = headers.TryGetValue("Content-Length", out var l) && int.TryParse(l, out var n) ? n : 0;
        if (length is < 0 or > MaxBody)
        {
            throw new FormatException("too large");
        }
        var body = new byte[length];
        var have = Math.Min((int)buffer.Length - headerEnd - HeadEnd.Length, length);
        Array.Copy(buffer.GetBuffer(), headerEnd + HeadEnd.Length, body, 0, have);
        while (have < length)
        {
            var read = await stream.ReadAsync(body.AsMemory(have, length - have), cancel);
            if (read == 0)
            {
                throw new FormatException("short body");
            }
            have += read;
        }
        return new PhoneRequest(start[0], path, headers, body);
    }

    /// <summary>A request's header lines as a dictionary (names in any case).</summary>
    private static Dictionary<string, string> HeadersOf(IEnumerable<string> lines)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var line in lines)
        {
            var colon = line.IndexOf(':');
            if (colon > 0)
            {
                headers[line[..colon].Trim()] = line[(colon + 1)..].Trim();
            }
        }
        return headers;
    }

    private static async Task WriteResponse(Stream stream, PhoneReply reply, CancellationToken cancel)
    {
        var reason = Reasons.GetValueOrDefault(reply.Status, "Error");
        var head = $"HTTP/1.1 {(int)reply.Status} {reason}\r\nContent-Type: {reply.Type}\r\nContent-Length: {reply.Content.Length}\r\n" +
                   "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\nX-Content-Type-Options: nosniff\r\n" +
                   $"{reply.Extra}Connection: close\r\n\r\n";
        await stream.WriteAsync(Encoding.ASCII.GetBytes(head), cancel);
        await stream.WriteAsync(reply.Content, cancel);
        await stream.FlushAsync(cancel);
    }

    private static readonly PhoneReply NotFound = new(HttpStatusCode.NotFound, MediaTypes.PlainText, []);
    private static readonly PhoneReply Forbidden = new(HttpStatusCode.Forbidden, MediaTypes.PlainText, []);

    /// <summary>Plain http: the setup page and the certificate, for a phone that doesn't trust Termilly yet.</summary>
    private async Task<PhoneReply> RespondPlain(PhoneRequest request)
    {
        if (request.Method != HttpMethod.Get.Method)
        {
            return new(HttpStatusCode.MethodNotAllowed, MediaTypes.PlainText, []);
        }
        if (request.Path == CertificatePath)
        {
            return new(HttpStatusCode.OK, CertificateType, _authorityFile, "Content-Disposition: attachment; filename=\"Termilly.cer\"\r\n");
        }
        var name = request.Path == "/" ? SetupPage : request.Path.TrimStart('/');
        return SetupFiles.Contains(name) ? await StaticFile(name) : NotFound;
    }

    /// <summary>HTTPS: the phone app's files, and its API.</summary>
    private async Task<PhoneReply> RespondSecure(PhoneRequest request)
    {
        if (PcFilesApi.Handles(request.Path))
        {
            return _files is not null && request.Method == HttpMethod.Post.Method && _api.DeviceOf(request) is not null
                ? await Task.Run(() => _files.Answer(request))
                : Forbidden;
        }
        if (request.Path == PcPrompts.Path)
        {
            return _prompts is not null && request.Method == HttpMethod.Post.Method && _api.DeviceOf(request) is not null
                ? await _prompts.AnswerAsync(request)
                : Forbidden;
        }
        if (request.Path.StartsWith("/api/", StringComparison.Ordinal))
        {
            return _api.Answer(request) ?? Forbidden;
        }
        if (request.Method != HttpMethod.Get.Method)
        {
            return new(HttpStatusCode.MethodNotAllowed, MediaTypes.PlainText, []);
        }
        return await StaticFile(request.Path == "/" ? IndexPage : Uri.UnescapeDataString(request.Path.TrimStart('/')));
    }

    /// <summary>The page's own files the phone app uses too: xterm.js, for its terminal view.</summary>
    private static readonly string[] SharedFiles = ["lib/xterm.js", "lib/xterm.css"];

    /// <summary>A file of the phone app, from wwwroot/phone only (and xterm.js from wwwroot/lib).</summary>
    private async Task<PhoneReply> StaticFile(string relative)
    {
        if (SharedFiles.Contains(relative))
        {
            var shared = Path.Combine(Path.GetDirectoryName(_webRoot)!, relative);
            return File.Exists(shared) ? new(HttpStatusCode.OK, Types.GetValueOrDefault(Path.GetExtension(shared), MediaTypes.Binary), await File.ReadAllBytesAsync(shared), PageSecurity) : NotFound;
        }
        var file = Path.GetFullPath(Path.Combine(_webRoot, relative));
        if (!file.StartsWith(_webRoot + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) || !File.Exists(file))
        {
            return NotFound;
        }
        var type = Types.GetValueOrDefault(Path.GetExtension(file), MediaTypes.Binary);
        return new(HttpStatusCode.OK, type, await File.ReadAllBytesAsync(file), PageSecurity);
    }
}
