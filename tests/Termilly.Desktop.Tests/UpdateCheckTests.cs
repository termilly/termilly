using System.Text;

namespace Termilly.Desktop.Tests;

public sealed class UpdateCheckTests
{
    // A throwaway key pair (not the release key); the signature was made with `openssl pkeyutl -sign -rawin`,
    // as the Release workflow does.
    private const string TestKey = "1Yez3KTaSSbHmynE8X7MMv3E7lZpJfOTtYQR0afWoqc=";
    private const string Manifest = """{"version":"1.1.0","date":"2026-11-02","notes":"https://termilly.com/","windows":{"online":"https://termilly.com/downloads/1.1.0/TermillySetup-1.1.0-online.exe"},"linux":{"deb":"https://termilly.com/downloads/1.1.0/termilly_1.1.0_amd64.deb"}}""";
    private const string Signature = "ByTFgAENonisoBb/zBm+PDNGVWKERLDUfgizdcGt4VUbXMz09Nf3Gd0h3W/jZsTv79FwqzNhzea53F24SNuDAg==";

    [Theory]
    // RFC 8032 section 7.1, tests 1 and 2.
    [InlineData("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "",
        "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")]
    [InlineData("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c", "72",
        "92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00")]
    public void Ed25519_verifies_the_rfc_test_vectors(string publicKey, string message, string signature)
    {
        Assert.True(Ed25519.Verify(Convert.FromHexString(publicKey), Convert.FromHexString(message), Convert.FromHexString(signature)));

        var wrong = Convert.FromHexString(signature);
        wrong[5] ^= 1;
        Assert.False(Ed25519.Verify(Convert.FromHexString(publicKey), Convert.FromHexString(message), wrong));
        Assert.False(Ed25519.Verify(Convert.FromHexString(publicKey), [1, 2, 3], Convert.FromHexString(signature)));
    }

    [Fact]
    public void A_signed_manifest_is_read()
    {
        var manifest = UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), Signature, TestKey);

        Assert.NotNull(manifest);
        Assert.Equal("1.1.0", manifest.Version);
        Assert.Equal("https://termilly.com/", manifest.Notes);
        Assert.EndsWith("online.exe", manifest.WindowsOnline);
        Assert.EndsWith("amd64.deb", manifest.LinuxDeb);
    }

    [Fact]
    public void A_manifest_that_does_not_verify_is_ignored()
    {
        var tampered = Encoding.UTF8.GetBytes(Manifest.Replace("1.1.0", "9.9.9"));

        Assert.Null(UpdateCheck.Read(tampered, Signature, TestKey));
        Assert.Null(UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), Signature)); // signed with another key
        Assert.Null(UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), "not base64!", TestKey));
        Assert.Null(UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), "", TestKey));
    }

    [Theory]
    [InlineData("1.1.0", "1.0.0", true)]
    [InlineData("1.0.1", "1.0.0", true)]
    [InlineData("2.0", "1.9.9", true)]
    [InlineData("1.0.0", "1.0.0", false)]
    [InlineData("1.0", "1.0.0", false)]
    [InlineData("0.9.0", "1.0.0", false)]
    [InlineData("junk", "1.0.0", false)]
    public void Only_a_later_version_counts(string candidate, string current, bool newer)
    {
        Assert.Equal(newer, UpdateCheck.IsNewer(candidate, current));
    }
}
