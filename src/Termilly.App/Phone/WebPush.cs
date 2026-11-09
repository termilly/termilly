using System.Buffers.Binary;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Termilly.Desktop.Phone;

/// <summary>Where a phone takes its alerts: the push service's address for it, and its keys (from the browser).</summary>
internal sealed record PushTarget(string Endpoint, string P256dh, string Auth);

/// <summary>
/// Alerts to a locked phone (docs/phone.md), the standard Web Push way: each alert is encrypted for the phone alone
/// (RFC 8291, aes128gcm), and Termilly signs that it sent it (VAPID, RFC 8292). The phone's push service (Apple's or
/// Google's) only carries it; it can't read it.
/// </summary>
internal static class WebPush
{
    /// <summary>The record size written in the header: one record holds the whole alert.</summary>
    private const int RecordSize = 4096;
    private const int SaltBytes = 16;
    private const int KeyBytes = 16;
    private const int NonceBytes = 12;
    private const int TagBytes = 16;
    private const int SecretBytes = 32;
    /// <summary>An uncompressed P-256 point: 0x04, then x and y.</summary>
    private const int PointBytes = 65;
    private const int CoordinateBytes = 32;
    private const byte Uncompressed = 0x04;
    /// <summary>Base64 writes 4 characters for each 3 bytes; base64url leaves the padding off.</summary>
    private const int Base64Block = 4;
    /// <summary>Ends the last (only) record's text, before its padding.</summary>
    private const byte LastRecord = 0x02;
    /// <summary>How long the push service keeps an alert for a phone that's offline.</summary>
    private const int KeepSeconds = 3600;
    /// <summary>How long a VAPID token is good for (the services take up to a day).</summary>
    private static readonly TimeSpan TokenLife = TimeSpan.FromHours(12);
    /// <summary>Who sends: the services ask for a contact; Termilly's site.</summary>
    private const string Subject = "https://termilly.com";

    private static readonly byte[] KeyInfo = "WebPush: info\0"u8.ToArray();
    private static readonly byte[] KeyLabel = "Content-Encoding: aes128gcm\0"u8.ToArray();
    private static readonly byte[] NonceLabel = "Content-Encoding: nonce\0"u8.ToArray();

    /// <summary>The key a browser subscribes with (applicationServerKey): Termilly's VAPID public key, base64url.</summary>
    public static string PublicKey(ECDsa vapid) => Base64Url(Point(vapid.ExportParameters(false)));

    /// <summary>
    /// The alert encrypted for one phone. <paramref name="sender"/> and <paramref name="salt"/> are fresh each time;
    /// tests pass RFC 8291's own to check the result.
    /// </summary>
    public static byte[] Encrypt(byte[] plaintext, byte[] phoneKey, byte[] authSecret, ECDiffieHellman? sender = null, byte[]? salt = null)
    {
        using var own = sender is null ? ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256) : null;
        var local = sender ?? own!;
        salt ??= RandomNumberGenerator.GetBytes(SaltBytes);
        var localPoint = Point(local.ExportParameters(false));
        using var phone = ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            Q = new ECPoint { X = phoneKey[1..(1 + CoordinateBytes)], Y = phoneKey[(1 + CoordinateBytes)..PointBytes] },
        });
        var shared = local.DeriveRawSecretAgreement(phone.PublicKey);
        var info = Concat(KeyInfo, phoneKey, localPoint);
        var ikm = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, SecretBytes, authSecret, info);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, KeyBytes, salt, KeyLabel);
        var nonce = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, NonceBytes, salt, NonceLabel);

        var record = Concat(plaintext, [LastRecord]);
        var sealedRecord = new byte[record.Length + TagBytes];
        using (var gcm = new AesGcm(key, TagBytes))
        {
            gcm.Encrypt(nonce, record, sealedRecord.AsSpan(0, record.Length), sealedRecord.AsSpan(record.Length));
        }
        var size = new byte[sizeof(uint)];
        BinaryPrimitives.WriteUInt32BigEndian(size, RecordSize);
        return Concat(salt, size, [(byte)localPoint.Length], localPoint, sealedRecord);
    }

    /// <summary>The VAPID token for one push service (its origin), signed with Termilly's key (ES256).</summary>
    public static string Token(ECDsa vapid, string audience, DateTimeOffset expires)
    {
        var header = Base64Url(Encoding.UTF8.GetBytes("""{"typ":"JWT","alg":"ES256"}"""));
        var claims = Base64Url(JsonSerializer.SerializeToUtf8Bytes(new Dictionary<string, object>
        {
            ["aud"] = audience, ["exp"] = expires.ToUnixTimeSeconds(), ["sub"] = Subject,
        }));
        var signature = vapid.SignData(Encoding.ASCII.GetBytes($"{header}.{claims}"), HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        return $"{header}.{claims}.{Base64Url(signature)}";
    }

    /// <summary>Sends one alert. The status says how it went: 404 and 410 mean the phone dropped this subscription.</summary>
    public static async Task<HttpStatusCode> SendAsync(HttpClient http, ECDsa vapid, PushTarget target, string json, CancellationToken cancel)
    {
        var endpoint = new Uri(target.Endpoint);
        var body = Encrypt(Encoding.UTF8.GetBytes(json), FromBase64Url(target.P256dh), FromBase64Url(target.Auth));
        using var request = new HttpRequestMessage(HttpMethod.Post, endpoint) { Content = new ByteArrayContent(body) };
        request.Content.Headers.ContentType = new("application/octet-stream");
        request.Content.Headers.ContentEncoding.Add("aes128gcm");
        request.Headers.Add("TTL", KeepSeconds.ToString(System.Globalization.CultureInfo.InvariantCulture));
        request.Headers.Add("Urgency", "high");
        var token = Token(vapid, endpoint.GetLeftPart(UriPartial.Authority), DateTimeOffset.UtcNow.Add(TokenLife));
        request.Headers.TryAddWithoutValidation("Authorization", $"vapid t={token}, k={PublicKey(vapid)}");
        using var response = await http.SendAsync(request, cancel).ConfigureAwait(false);
        return response.StatusCode;
    }

    /// <summary>An uncompressed P-256 point: 0x04, x, y (each padded to 32 bytes).</summary>
    private static byte[] Point(ECParameters key)
    {
        var point = new byte[PointBytes];
        point[0] = Uncompressed;
        key.Q.X!.CopyTo(point, 1 + CoordinateBytes - key.Q.X!.Length);
        key.Q.Y!.CopyTo(point, PointBytes - key.Q.Y!.Length);
        return point;
    }

    private static byte[] Concat(params byte[][] parts)
    {
        var all = new byte[parts.Sum(p => p.Length)];
        var at = 0;
        foreach (var part in parts)
        {
            part.CopyTo(all, at);
            at += part.Length;
        }
        return all;
    }

    public static string Base64Url(byte[] data) => Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    public static byte[] FromBase64Url(string text)
    {
        var s = text.Replace('-', '+').Replace('_', '/');
        return Convert.FromBase64String(s.PadRight(s.Length + ((Base64Block - (s.Length % Base64Block)) % Base64Block), '='));
    }
}
