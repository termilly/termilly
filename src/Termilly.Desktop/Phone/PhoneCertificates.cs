using System.Net;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Termilly's own certificate authority for the phone app's HTTPS (docs/phone.md): made once, kept sealed in the
/// vault (PhoneStore), and installed once on each phone. From it, a server certificate for this PC's addresses is
/// made each time the server starts, so a new address needs nothing on the phones.
/// </summary>
internal static class PhoneCertificates
{
    /// <summary>The authority outlives any server certificate it signs.</summary>
    private const int AuthorityYears = 10;
    /// <summary>
    /// A server certificate's life: iOS refuses longer than 825 days, and Apple's 398-day rule for public ones is kept
    /// too in case it's ever applied to installed ones.
    /// </summary>
    private const int ServerDays = 397;
    /// <summary>Valid from a day back, so a phone whose clock is a little behind still takes it.</summary>
    private const int BackdateDays = 1;
    private const int SerialBytes = 16;
    /// <summary>Clears a serial number's top bit, so it reads as a positive number.</summary>
    private const byte PositiveSerial = 0x7F;
    /// <summary>The extended key usage of a TLS server.</summary>
    private const string ServerAuthentication = "1.3.6.1.5.5.7.3.1";

    /// <summary>A new authority, with its private key (exportable, to keep it sealed).</summary>
    public static X509Certificate2 CreateAuthority(string machine)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN=Termilly on {machine}, O=Termilly", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign | X509KeyUsageFlags.CrlSign, true));
        request.CertificateExtensions.Add(new X509SubjectKeyIdentifierExtension(request.PublicKey, false));
        var now = DateTimeOffset.UtcNow;
        using var made = request.CreateSelfSigned(now.AddDays(-BackdateDays), now.AddYears(AuthorityYears));
        return Reload(made);
    }

    /// <summary>A server certificate for these addresses and host name, signed by the authority.</summary>
    public static X509Certificate2 IssueServer(X509Certificate2 authority, IEnumerable<IPAddress> addresses, string host)
    {
        using var key = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var request = new CertificateRequest($"CN={host}", key, HashAlgorithmName.SHA256);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension([new Oid(ServerAuthentication)], false));
        var names = new SubjectAlternativeNameBuilder();
        names.AddDnsName(host);
        foreach (var address in addresses)
        {
            names.AddIpAddress(address);
        }
        request.CertificateExtensions.Add(names.Build());
        request.CertificateExtensions.Add(X509AuthorityKeyIdentifierExtension.CreateFromCertificate(authority, true, false));
        var now = DateTimeOffset.UtcNow;
        var serial = RandomNumberGenerator.GetBytes(SerialBytes);
        serial[0] &= PositiveSerial;
        using var signed = request.Create(authority, now.AddDays(-BackdateDays), now.AddDays(ServerDays), serial);
        using var withKey = signed.CopyWithPrivateKey(key);
        return Reload(withKey);
    }

    /// <summary>The authority as a phone installs it: the certificate alone, DER.</summary>
    public static byte[] AuthorityFile(X509Certificate2 authority) => authority.Export(X509ContentType.Cert);

    public static byte[] ToPkcs12(X509Certificate2 certificate) => certificate.Export(X509ContentType.Pkcs12);

    public static X509Certificate2 FromPkcs12(byte[] data) => X509CertificateLoader.LoadPkcs12(data, null, X509KeyStorageFlags.Exportable);

    /// <summary>
    /// The certificate read back from PKCS#12: a key made in memory can't be used for TLS by Windows (SChannel); one
    /// loaded from a PKCS#12 blob can.
    /// </summary>
    private static X509Certificate2 Reload(X509Certificate2 certificate) => FromPkcs12(ToPkcs12(certificate));
}
