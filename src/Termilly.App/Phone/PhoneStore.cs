using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Phone;

/// <summary>
/// What Termilly on a phone keeps (docs/phone.md), sealed with the vault key in phone.json: the certificate
/// authority phones trust, the key alerts are signed with (VAPID), and the paired phones. A phone holds a random
/// token (an HttpOnly cookie); only its hash is kept here. Nothing works while the vault is locked.
/// </summary>
internal sealed class PhoneStore(Vault vault)
{
    private const string FileName = "phone.json";
    /// <summary>How long a pairing code shown in Settings waits for the phone.</summary>
    private static readonly TimeSpan CodeLifetime = TimeSpan.FromMinutes(5);
    /// <summary>Wrong codes a pairing takes before it's withdrawn.</summary>
    private const int CodeTries = 10;
    /// <summary>A pairing code: 8 characters a phone keyboard types without confusion (no 0/O, 1/I/L).</summary>
    private const string CodeAlphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
    private const int CodeLength = 8;
    private const int TokenBytes = 32;
    private const int IdBytes = 8;
    /// <summary>"Last seen" is written at most this often (a phone asks often).</summary>
    private static readonly TimeSpan SeenEvery = TimeSpan.FromMinutes(1);
    private const string IPhone = "iPhone";
    private const string IPad = "iPad";

    private readonly Lock _gate = new();
    private Data? _data;
    private (string Code, DateTime Expires, int Tries)? _offer;

    /// <param name="Server">The server certificate last made, kept so a restart shows phones the same one.</param>
    private sealed record Data(string? Authority, string? Vapid, List<Device> Devices, string? Server = null);

    /// <summary>A paired phone as kept: its token's hash, never the token.</summary>
    private sealed record Device(string Id, string Name, string TokenHash, long Paired, long LastSeen, PushTarget? Push);

    /// <summary>A phone pairing or being removed, or its alerts changing.</summary>
    public event Action? Changed;

    public bool IsLocked => vault.IsLocked;

    private string FilePath => vault.PathOf(FileName);

    /// <summary>The certificate authority phones install, made the first time it's needed.</summary>
    public X509Certificate2 Authority(string machine)
    {
        lock (_gate)
        {
            var data = Load();
            if (data.Authority is { } kept)
            {
                return PhoneCertificates.FromPkcs12(Convert.FromBase64String(kept));
            }
            var made = PhoneCertificates.CreateAuthority(machine);
            Save(data with { Authority = Convert.ToBase64String(PhoneCertificates.ToPkcs12(made)) });
            return made;
        }
    }

    /// <summary>
    /// The server certificate for this PC's addresses: the one kept while it still names them, comes from this
    /// authority and has a month left; otherwise a new one, kept for next time. Phones that trust the authority take
    /// either; keeping it means a restart changes nothing they see.
    /// </summary>
    public X509Certificate2 ServerCertificate(X509Certificate2 authority, IReadOnlyList<IPAddress> addresses, string host)
    {
        lock (_gate)
        {
            var data = Load();
            if (data.Server is { } kept)
            {
                var certificate = PhoneCertificates.FromPkcs12(Convert.FromBase64String(kept));
                if (PhoneCertificates.Fits(certificate, authority, addresses, host))
                {
                    return certificate;
                }
                certificate.Dispose();
            }
            var made = PhoneCertificates.IssueServer(authority, addresses, host);
            Save(data with { Server = Convert.ToBase64String(PhoneCertificates.ToPkcs12(made)) });
            return made;
        }
    }

    /// <summary>The key alerts are signed with (VAPID), made the first time it's needed.</summary>
    public ECDsa Vapid()
    {
        lock (_gate)
        {
            var data = Load();
            var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
            if (data.Vapid is { } kept)
            {
                key.ImportPkcs8PrivateKey(Convert.FromBase64String(kept), out _);
            }
            else
            {
                Save(data with { Vapid = Convert.ToBase64String(key.ExportPkcs8PrivateKey()) });
            }
            return key;
        }
    }

    /// <summary>A new pairing code for Settings; the one before it stops working.</summary>
    public string OfferCode()
    {
        var chars = new char[CodeLength];
        for (var i = 0; i < chars.Length; i++)
        {
            chars[i] = CodeAlphabet[RandomNumberGenerator.GetInt32(CodeAlphabet.Length)];
        }
        var code = new string(chars);
        lock (_gate)
        {
            _offer = (code, DateTime.UtcNow + CodeLifetime, 0);
        }
        return code;
    }

    /// <summary>The longest name a phone may give itself.</summary>
    private const int MaxName = 40;

    /// <summary>
    /// A phone typed the code: its new token, or null when the code is wrong, used or old. It may give itself a name
    /// (else it's named after its kind: "iPhone"); a phone paired before under the same name is this one again (its Home
    /// Screen app was removed and added, which takes its token), so that pairing makes way for this one.
    /// </summary>
    public string? Pair(string? code, string? userAgent, string? name = null)
    {
        string token;
        lock (_gate)
        {
            if (_offer is not { } offer || offer.Expires < DateTime.UtcNow || vault.IsLocked)
            {
                return null;
            }
            var typed = (code ?? "").Trim().ToUpperInvariant().Replace(" ", "").Replace("-", "");
            if (!CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(typed), Encoding.ASCII.GetBytes(offer.Code)))
            {
                _offer = offer.Tries + 1 >= CodeTries ? null : offer with { Tries = offer.Tries + 1 };
                return null;
            }
            _offer = null;
            token = WebPush.Base64Url(RandomNumberGenerator.GetBytes(TokenBytes));
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var data = Load();
            var given = Clean(name);
            if (given is not null)
            {
                data.Devices.RemoveAll(d => string.Equals(d.Name, given, StringComparison.OrdinalIgnoreCase));
            }
            data.Devices.Add(new Device(Convert.ToHexString(RandomNumberGenerator.GetBytes(IdBytes)).ToLowerInvariant(), given ?? NameFrom(userAgent), Hash(token), now, now, null));
            Save(data);
        }
        Changed?.Invoke();
        return token;
    }

    /// <summary>The paired phone holding this token (its id), or null; notes that it was seen.</summary>
    public string? DeviceFor(string? token)
    {
        if (string.IsNullOrEmpty(token))
        {
            return null;
        }
        var hash = Hash(token);
        lock (_gate)
        {
            if (vault.IsLocked)
            {
                return null;
            }
            var data = Load();
            var index = data.Devices.FindIndex(d => CryptographicOperations.FixedTimeEquals(Encoding.ASCII.GetBytes(d.TokenHash), Encoding.ASCII.GetBytes(hash)));
            if (index < 0)
            {
                return null;
            }
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (now - data.Devices[index].LastSeen >= SeenEvery.TotalMilliseconds)
            {
                data.Devices[index] = data.Devices[index] with { LastSeen = now };
                Save(data);
            }
            return data.Devices[index].Id;
        }
    }

    /// <summary>Where a phone takes its alerts (null: none).</summary>
    public void SetPush(string id, PushTarget? target)
    {
        lock (_gate)
        {
            var data = Load();
            var index = data.Devices.FindIndex(d => d.Id == id);
            if (index < 0)
            {
                return;
            }
            data.Devices[index] = data.Devices[index] with { Push = target };
            Save(data);
        }
        Changed?.Invoke();
    }

    /// <summary>The phones that take alerts, with where to send them.</summary>
    public IReadOnlyList<(string Id, PushTarget Target)> PushTargets(string? only = null)
    {
        lock (_gate)
        {
            return vault.IsLocked ? [] : Load().Devices.Where(d => d.Push is not null && (only is null || d.Id == only)).Select(d => (d.Id, d.Push!)).ToList();
        }
    }

    public IReadOnlyList<PhoneDevice> List()
    {
        lock (_gate)
        {
            return vault.IsLocked ? [] : Load().Devices.Select(d => new PhoneDevice(d.Id, d.Name, d.Paired, d.LastSeen, d.Push is not null)).ToList();
        }
    }

    public void Remove(string id)
    {
        lock (_gate)
        {
            var data = Load();
            data.Devices.RemoveAll(d => d.Id == id);
            Save(data);
        }
        Changed?.Invoke();
    }

    /// <summary>Forgets what's in memory (after the vault changed, or in tests).</summary>
    public void Reset()
    {
        lock (_gate)
        {
            _data = null;
            _offer = null;
        }
    }

    /// <summary>A name as a phone gave it: one line, trimmed and cut to length; null when there's none.</summary>
    private static string? Clean(string? name)
    {
        var line = new string((name ?? "").Where(c => !char.IsControl(c)).ToArray()).Trim();
        return line.Length == 0 ? null : line[..Math.Min(line.Length, MaxName)].TrimEnd();
    }

    public static string NameFrom(string? userAgent) => userAgent switch
    {
        null => "Phone",
        _ when userAgent.Contains(IPhone) => IPhone,
        _ when userAgent.Contains(IPad) => IPad,
        _ when userAgent.Contains("Android") => "Android phone",
        _ => "Browser",
    };

    private static string Hash(string token) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(token)));

    private Data Load()
    {
        if (_data is not null)
        {
            return _data;
        }
        using var json = vault.ReadJson(FilePath);
        try
        {
            _data = json?.Deserialize<Data>() ?? new Data(null, null, []);
        }
        catch (JsonException)
        {
            _data = new Data(null, null, []);
        }
        if (_data.Devices is null)
        {
            _data = _data with { Devices = [] };
        }
        return _data;
    }

    private void Save(Data data)
    {
        _data = data;
        vault.WriteSealed(FilePath, JsonSerializer.Serialize(data));
    }
}
