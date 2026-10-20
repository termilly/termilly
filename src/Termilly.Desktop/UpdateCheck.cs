using System.Net.Http;
using System.Text.Json;

namespace Termilly.Desktop;

/// <summary>What latest.json announces: the newest version and where to get it.</summary>
internal sealed record UpdateManifest(
    string Version,
    string? Date,
    string? Notes,
    string? WindowsOnline,
    string? WindowsFull,
    string? LinuxDeb);

/// <summary>
/// Finds out whether a newer Termilly is out. The Release workflow publishes latest.json and its Ed25519 signature
/// (latest.json.sig, base64) next to the installers; a manifest whose signature doesn't verify against the key
/// below is ignored, so a compromised download server can't announce a fake version. Nothing is downloaded or run:
/// the page shows a notice, and the user's browser fetches the installer if they choose to.
/// </summary>
internal static class UpdateCheck
{
    /// <summary>The release signing key's public half (the private half is the RELEASE_SIGNING_KEY secret).</summary>
    public const string PublicKey = "NYuUvEzE+7Du7FfAg79t1plCM5UEvECXehb+7+j01C0=";

    /// <summary>Where the manifest lives; TERMILLY_UPDATE_URL points elsewhere (tests, a beta channel).</summary>
    public static Uri ManifestUri =>
        new(Environment.GetEnvironmentVariable("TERMILLY_UPDATE_URL") is { Length: > 0 } url ? url : "https://termilly.com/downloads/latest.json");

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromSeconds(20) };

    /// <summary>The manifest's fields (latest.json, written by the release workflow).</summary>
    private static class Fields
    {
        public const string Version = "version";
        public const string Date = "date";
        public const string Notes = "notes";
        public const string Windows = "windows";
        public const string Linux = "linux";
        /// <summary>Windows' online installer, and its full one with everything in it.</summary>
        public const string Online = "online";
        public const string Full = "full";
        public const string Deb = "deb";
    }

    /// <summary>The manifest, if its signature verifies and it parses; null otherwise.</summary>
    public static UpdateManifest? Read(byte[] json, string signature, string publicKey = PublicKey)
    {
        byte[] sig, key;
        try
        {
            sig = Convert.FromBase64String(signature.Trim());
            key = Convert.FromBase64String(publicKey);
        }
        catch (FormatException)
        {
            return null;
        }
        if (!Ed25519.Verify(key, json, sig))
        {
            return null;
        }
        try
        {
            using var doc = JsonDocument.Parse(json);
            var root = doc.RootElement;
            var version = Text(root, Fields.Version);
            if (version is null || !System.Version.TryParse(version, out _))
            {
                return null;
            }
            var windows = root.TryGetProperty(Fields.Windows, out var w) ? w : default;
            var linux = root.TryGetProperty(Fields.Linux, out var l) ? l : default;
            return new UpdateManifest(version, Text(root, Fields.Date), Text(root, Fields.Notes),
                Text(windows, Fields.Online), Text(windows, Fields.Full), Text(linux, Fields.Deb));
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Whether <paramref name="candidate"/> is a later version than <paramref name="current"/> (major.minor.patch).</summary>
    public static bool IsNewer(string candidate, string current) =>
        System.Version.TryParse(candidate, out var a) && System.Version.TryParse(current, out var b) && Normal(a) > Normal(b);

    /// <summary>Fetches and checks the manifest; null when offline, the server is down or it doesn't verify.</summary>
    public static async Task<UpdateManifest?> FetchAsync(CancellationToken cancel = default)
    {
        try
        {
            var uri = ManifestUri;
            var json = await Http.GetByteArrayAsync(uri, cancel).ConfigureAwait(false);
            var signature = await Http.GetStringAsync(new Uri(uri + ".sig"), cancel).ConfigureAwait(false);
            return Read(json, signature);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException or UriFormatException)
        {
            return null;
        }
    }

    /// <summary>1.1 and 1.1.0 are the same version.</summary>
    private static Version Normal(Version v) => new(v.Major, Math.Max(v.Minor, 0), Math.Max(v.Build, 0));

    private static string? Text(JsonElement element, string name) =>
        element.ValueKind == JsonValueKind.Object && element.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
}
