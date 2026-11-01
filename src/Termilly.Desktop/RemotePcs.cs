using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// Another Termilly computer this one is paired with: its name, its address (host:port of its phone server), the token
/// its pairing gave, and its certificate authority (DER, base64), the only one trusted for it.
/// </summary>
internal sealed record RemotePc(string Id, string Name, string Address, string Token, string Authority);

/// <summary>The paired computers, kept in the vault (their tokens let anyone holding them type there).</summary>
internal sealed class RemotePcStore(Vault vault)
{
    private const string FileName = "computers.tmw";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Lock _lock = new();

    private string FilePath => vault.PathOf(FileName);

    public IReadOnlyList<RemotePc> List()
    {
        lock (_lock)
        {
            using var doc = vault.ReadJson(FilePath);
            return doc?.RootElement.Deserialize<List<RemotePc>>(Json) ?? [];
        }
    }

    /// <summary>Keeps a computer; one at the same address replaces the old pairing.</summary>
    public void Add(RemotePc pc)
    {
        lock (_lock)
        {
            var list = List().Where(p => !string.Equals(p.Address, pc.Address, StringComparison.OrdinalIgnoreCase)).Append(pc).ToList();
            vault.WriteSealed(FilePath, JsonSerializer.Serialize(list, Json));
        }
    }

    public void Remove(string id)
    {
        lock (_lock)
        {
            vault.WriteSealed(FilePath, JsonSerializer.Serialize(List().Where(p => p.Id != id).ToList(), Json));
        }
    }
}

/// <summary>
/// Reaching another Termilly over its phone server (Phone/PhoneServer.cs): pairing with the code its Settings › Phone
/// shows, and its live connection. Its certificate is checked against its own authority only, fetched at pairing (the
/// code the user types proves this computer to it; the authority is kept from then on).
/// </summary>
internal static class PcConnection
{
    public const int DefaultPort = PhoneSettings.DefaultPort;
    /// <summary>What a computer's paired name ends with on the other side ("LAPTOP (Termilly)"): it isn't a phone.</summary>
    public const string ComputerMark = " (Termilly)";
    private const string AuthorityPath = "/termilly.cer";
    private const string PairPath = "/api/pair";
    private const string LivePath = "/api/live";
    private const string TokenCookie = "termilly";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(10);
    private const int ReceiveBuffer = 16 * 1024;
    /// <summary>How often a quiet live connection is pinged, so a dropped one is noticed.</summary>
    private const int KeepAliveSeconds = 20;
    private static readonly TimeSpan KeepAlive = TimeSpan.FromSeconds(KeepAliveSeconds);

    /// <summary>"192.168.0.108", "https://desktop.local:8765/" or "desktop:9000" as host:port; null when it isn't one.</summary>
    public static string? AddressOf(string text)
    {
        var trimmed = text.Trim();
        if (trimmed.Length == 0)
        {
            return null;
        }
        var withScheme = trimmed.Contains("://", StringComparison.Ordinal) ? trimmed : "https://" + trimmed;
        if (!Uri.TryCreate(withScheme, UriKind.Absolute, out var uri) || string.IsNullOrEmpty(uri.Host))
        {
            return null;
        }
        return $"{uri.Host}:{(uri.IsDefaultPort ? DefaultPort : uri.Port)}";
    }

    /// <summary>Whether a server certificate comes from this computer's authority, for its address.</summary>
    public static bool Trusted(X509Certificate? certificate, X509Certificate2 authority, SslPolicyErrors errors)
    {
        if (certificate is null || errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch) || errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable))
        {
            return false;
        }
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(authority);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        using var server = new X509Certificate2(certificate);
        return chain.Build(server);
    }

    /// <summary>
    /// Pairs with the Termilly at <paramref name="address"/>: fetches its authority, then hands it the code over HTTPS
    /// checked against that authority. Throws <see cref="InvalidOperationException"/> with what went wrong, for the user.
    /// </summary>
    public static async Task<RemotePc> PairAsync(string address, string code, string myName, CancellationToken cancel)
    {
        using var plain = new HttpClient { Timeout = Timeout };
        byte[] der;
        try
        {
            der = await plain.GetByteArrayAsync(new Uri($"http://{address}{AuthorityPath}"), cancel).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new InvalidOperationException($"Couldn’t reach Termilly at {address}. Is Termilly on the phone turned on there (Settings › Phone)?", e);
        }
        using var authority = X509CertificateLoader.LoadCertificate(der);
        using var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, cert, _, errors) => Trusted(cert, authority, errors), UseCookies = false };
        using var secure = new HttpClient(handler) { Timeout = Timeout };
        var body = new JsonObject { ["code"] = code, ["name"] = myName }.ToJsonString();
        using var response = await secure.PostAsync(new Uri($"https://{address}{PairPath}"), new StringContent(body, Encoding.UTF8, "application/json"), cancel).ConfigureAwait(false);
        var token = response.Headers.TryGetValues("Set-Cookie", out var cookies) ? cookies.Select(TokenFrom).FirstOrDefault(t => t is not null) : null;
        if (response.StatusCode == HttpStatusCode.Forbidden || token is null)
        {
            throw new InvalidOperationException("That code didn’t work: it’s wrong or old. Show a new one there, in Settings › Phone › Set up a phone.");
        }
        return new RemotePc(Guid.NewGuid().ToString("N"), await NameOf(address).ConfigureAwait(false), address, token, Convert.ToBase64String(der));
    }

    private static string? TokenFrom(string cookie)
    {
        var first = cookie.Split(';')[0].Trim();
        return first.StartsWith(TokenCookie + "=", StringComparison.Ordinal) && first.Length > TokenCookie.Length + 1 ? first[(TokenCookie.Length + 1)..] : null;
    }

    /// <summary>The computer's own name where the network says it (its first label), else its address.</summary>
    private static async Task<string> NameOf(string address)
    {
        var host = address[..address.LastIndexOf(':')];
        try
        {
            var entry = IPAddress.TryParse(host, out _) ? await Dns.GetHostEntryAsync(host).ConfigureAwait(false) : null;
            var name = entry?.HostName.Split('.')[0];
            return string.IsNullOrEmpty(name) || name == host ? host : name;
        }
        catch (System.Net.Sockets.SocketException)
        {
            return host;
        }
    }

    /// <summary>
    /// An HTTPS client for the computer's API, trusting only its own authority and sending this computer's token (its
    /// files, for Copy to: Features/RemotePcFiles.cs).
    /// </summary>
    public static HttpClient ClientFor(RemotePc pc, TimeSpan timeout)
    {
        var authority = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(pc.Authority));
        var handler = new HttpClientHandler { ServerCertificateCustomValidationCallback = (_, cert, _, errors) => Trusted(cert, authority, errors), UseCookies = false };
        var client = new HttpClient(handler, disposeHandler: true) { Timeout = timeout, BaseAddress = new Uri($"https://{pc.Address}") };
        client.DefaultRequestHeaders.Add(Phone.PhoneAppApi.CookieHeader, $"{TokenCookie}={pc.Token}");
        return client;
    }

    /// <summary>Opens the computer's live connection (what its phone app gets), with this computer's token.</summary>
    public static async Task<ClientWebSocket> ConnectAsync(RemotePc pc, CancellationToken cancel)
    {
        var authority = X509CertificateLoader.LoadCertificate(Convert.FromBase64String(pc.Authority));
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader(Phone.PhoneAppApi.CookieHeader, $"{TokenCookie}={pc.Token}");
        socket.Options.RemoteCertificateValidationCallback = (_, cert, _, errors) => Trusted(cert, authority, errors);
        socket.Options.KeepAliveInterval = KeepAlive;
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(Timeout);
        try
        {
            await socket.ConnectAsync(new Uri($"wss://{pc.Address}{LivePath}"), timeout.Token).ConfigureAwait(false);
            return socket;
        }
        catch
        {
            socket.Dispose();
            throw;
        }
        finally
        {
            authority.Dispose();
        }
    }

    /// <summary>The next message on a live connection, or null once it's closed.</summary>
    public static async Task<JsonObject?> ReceiveAsync(WebSocket socket, CancellationToken cancel)
    {
        var buffer = new byte[ReceiveBuffer];
        using var message = new MemoryStream();
        while (true)
        {
            var got = await socket.ReceiveAsync(buffer, cancel).ConfigureAwait(false);
            if (got.MessageType == WebSocketMessageType.Close)
            {
                return null;
            }
            message.Write(buffer, 0, got.Count);
            if (got.EndOfMessage)
            {
                try
                {
                    return JsonNode.Parse(message.ToArray()) as JsonObject ?? [];
                }
                catch (JsonException)
                {
                    return [];
                }
            }
        }
    }

    /// <summary>Sends a message; <paramref name="gate"/> keeps sends one at a time, as a WebSocket needs.</summary>
    public static async Task SendAsync(WebSocket socket, SemaphoreSlim gate, JsonObject message, CancellationToken cancel)
    {
        var bytes = Encoding.UTF8.GetBytes(message.ToJsonString());
        await gate.WaitAsync(cancel).ConfigureAwait(false);
        try
        {
            await socket.SendAsync(bytes, WebSocketMessageType.Text, true, cancel).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }
}
