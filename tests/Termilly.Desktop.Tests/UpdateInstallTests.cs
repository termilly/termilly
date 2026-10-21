using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace Termilly.Desktop.Tests;

public sealed class UpdateInstallTests : IDisposable
{
    // A throwaway key pair (not the release key), signed as the Release workflow does (openssl pkeyutl -sign -rawin).
    private const string TestKey = "RIGY4Zh5B5QvaQDgzKT9UZ8x/3wGedTmXB23CkwvkVo=";
    private const string Manifest = """{"version":"1.2.0","date":"2026-12-01","notes":"https://termilly.com/","windows":{"online":"https://termilly.com/downloads/1.2.0/TermillySetup-1.2.0-online.exe","full":"https://termilly.com/downloads/1.2.0/TermillySetup-1.2.0.exe","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","fullSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},"linux":{"deb":"https://termilly.com/downloads/1.2.0/termilly_1.2.0_amd64.deb","sha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}}""";
    private const string Signature = "gxYDXbo4X34TCF/6H8dR2ZOPWbEpZ29ITnXuI7y/SYAXVvEL6xXCopGLu1WbEW+jzyW8ex4fL0giLnC/KZjdCw==";
    private static readonly string HashA = new('a', 64);
    private static readonly string HashB = new('b', 64);

    private readonly string _folder = Path.Combine(Path.GetTempPath(), "termilly-update-test-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_folder))
        {
            Directory.Delete(_folder, recursive: true);
        }
    }

    // ---- The manifest's installers ----

    [Fact]
    public void A_signed_manifest_gives_each_installers_sha256()
    {
        var manifest = UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), Signature, TestKey);

        Assert.NotNull(manifest);
        Assert.Equal(HashA, manifest.WindowsOnlineSha256);
        Assert.Equal(HashB, manifest.WindowsFullSha256);
        Assert.Equal(new string('c', 64), manifest.LinuxDebSha256);
    }

    [Fact]
    public void Windows_gets_the_online_setup_and_linux_the_package()
    {
        var manifest = UpdateCheck.Read(Encoding.UTF8.GetBytes(Manifest), Signature, TestKey)!;

        var windows = UpdateCheck.Package(manifest, linux: false);
        var linux = UpdateCheck.Package(manifest, linux: true);

        Assert.Equal("TermillySetup-1.2.0-online.exe", windows?.FileName);
        Assert.Equal(HashA, windows?.Sha256);
        Assert.Equal("termilly_1.2.0_amd64.deb", linux?.FileName);
    }

    [Fact]
    public void Without_an_online_setup_windows_gets_the_full_one()
    {
        var manifest = new UpdateManifest("1.2.0", null, null, null, "https://termilly.com/full.exe", null) { WindowsFullSha256 = HashB };

        Assert.Equal(new UpdatePackage(new Uri("https://termilly.com/full.exe"), HashB), UpdateCheck.Package(manifest, linux: false));
    }

    [Theory]
    [InlineData("https://termilly.com/s.exe", null)] // no checksum: nothing unchecked runs
    [InlineData("https://termilly.com/s.exe", "not-a-sha256")]
    [InlineData("http://termilly.com/s.exe", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")] // not HTTPS
    [InlineData("ftp://termilly.com/s.exe", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    [InlineData(null, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")]
    public void An_installer_that_cant_be_checked_isnt_offered(string? url, string? sha256)
    {
        var manifest = new UpdateManifest("1.2.0", null, null, url, null, null) { WindowsOnlineSha256 = sha256 };

        Assert.Null(UpdateCheck.Package(manifest, linux: false));
    }

    // ---- Downloading ----

    [Fact]
    public async Task A_download_with_the_right_sha256_is_kept()
    {
        var body = Encoding.UTF8.GetBytes("setup bytes");
        var download = new UpdateDownload(Serving(body), _folder);
        var percents = new List<int>();

        var file = await download.DownloadAsync(Package(body), new Percents(percents.Add), CancellationToken.None);

        Assert.Equal(body, await File.ReadAllBytesAsync(file));
        Assert.Equal(Path.Combine(_folder, "TermillySetup-1.2.0-online.exe"), file);
        Assert.Equal(100, percents[^1]);
        Assert.True(UpdateDownload.IsIntact(file, Package(body).Sha256));
    }

    [Fact]
    public async Task A_download_with_another_sha256_is_never_kept()
    {
        var download = new UpdateDownload(Serving(Encoding.UTF8.GetBytes("changed on the way")), _folder);

        await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            download.DownloadAsync(Package(Encoding.UTF8.GetBytes("the real setup")), new Percents(_ => { }), CancellationToken.None));

        Assert.Empty(Directory.GetFiles(_folder));
    }

    [Fact]
    public async Task A_cancelled_download_leaves_nothing()
    {
        using var cancel = new CancellationTokenSource();
        var body = new byte[1 << 20];
        var download = new UpdateDownload(Serving(body), _folder);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            download.DownloadAsync(Package(body), new Percents(_ => cancel.Cancel()), cancel.Token));

        Assert.Empty(Directory.GetFiles(_folder));
    }

    [Fact]
    public async Task A_server_error_is_said_and_leaves_nothing()
    {
        var download = new UpdateDownload(new HttpClient(new Answer(_ => new HttpResponseMessage(HttpStatusCode.NotFound))), _folder);

        var error = await Assert.ThrowsAsync<UpdateDownloadException>(() =>
            download.DownloadAsync(Package([1, 2, 3]), new Percents(_ => { }), CancellationToken.None));

        Assert.StartsWith("Couldn't download the update", error.Message);
        Assert.Empty(Directory.GetFiles(_folder));
    }

    [Fact]
    public async Task Only_https_is_downloaded_from()
    {
        var download = new UpdateDownload(Serving([1]), _folder);
        var plain = new UpdatePackage(new Uri("http://termilly.com/TermillySetup.exe"), HashA);

        await Assert.ThrowsAsync<UpdateDownloadException>(() => download.DownloadAsync(plain, new Percents(_ => { }), CancellationToken.None));
    }

    [Fact]
    public async Task A_downloaded_file_changed_afterwards_isnt_intact()
    {
        var body = Encoding.UTF8.GetBytes("setup bytes");
        var file = await new UpdateDownload(Serving(body), _folder).DownloadAsync(Package(body), new Percents(_ => { }), CancellationToken.None);

        await File.AppendAllTextAsync(file, "!");

        Assert.False(UpdateDownload.IsIntact(file, Package(body).Sha256));
        Assert.False(UpdateDownload.IsIntact(Path.Combine(_folder, "gone.exe"), Package(body).Sha256));
    }

    [Fact]
    public async Task Clear_removes_earlier_installers()
    {
        var body = Encoding.UTF8.GetBytes("setup bytes");
        var download = new UpdateDownload(Serving(body), _folder);
        await download.DownloadAsync(Package(body), new Percents(_ => { }), CancellationToken.None);

        download.Clear();

        Assert.False(Directory.Exists(_folder));
    }

    // ---- Installing ----

    [Fact]
    public void A_build_setup_didnt_install_gets_a_plain_quiet_install()
    {
        var command = SetupCommand.For(@"C:\Temp\TermillySetup.exe", installed: null);

        Assert.Equal("--quiet --start", command.Arguments);
        Assert.False(command.AsAdministrator);
        Assert.Equal(@"C:\Temp\TermillySetup.exe", command.File);
    }

    [Fact]
    public void A_per_user_install_is_updated_in_its_folder()
    {
        var command = SetupCommand.For("setup.exe", new InstalledCopy(@"C:\Users\me\AppData\Local\Programs\Termilly\", AllUsers: false));

        Assert.Equal(@"--quiet --start --dir ""C:\Users\me\AppData\Local\Programs\Termilly""", command.Arguments);
        Assert.False(command.AsAdministrator);
    }

    [Fact]
    public void An_install_for_all_users_is_updated_as_administrator()
    {
        var command = SetupCommand.For("setup.exe", new InstalledCopy(@"C:\Program Files\Termilly", AllUsers: true));

        Assert.Equal(@"--quiet --start --all-users --dir ""C:\Program Files\Termilly""", command.Arguments);
        Assert.True(command.AsAdministrator);
    }

    [Theory]
    [InlineData(@"C:\Apps\Termilly\", @"C:\apps\termilly", null, false)]
    [InlineData(@"C:\Program Files\Termilly\", @"C:\Users\me\Termilly", @"C:\Program Files\Termilly", true)]
    public void The_running_copy_is_matched_to_its_install(string runningFrom, string? perUser, string? allUsers, bool forAll)
    {
        var copy = InstalledCopy.Match(runningFrom, perUser, allUsers);

        Assert.NotNull(copy);
        Assert.Equal(forAll, copy.AllUsers);
    }

    [Fact]
    public void A_copy_setup_didnt_install_matches_nothing()
    {
        Assert.Null(InstalledCopy.Match(@"D:\dev\termilly\bin\Debug\", @"C:\Users\me\Termilly", null));
        Assert.Null(InstalledCopy.Match(@"D:\dev\termilly\bin\Debug\", null, "  "));
    }

    [Fact]
    public void Linux_installs_the_package_file_through_pkexec_and_restarts_after()
    {
        var package = Path.Combine(_folder, "termilly_1.2.0_amd64.deb");

        Assert.Equal([PackageCommands.Apt, "install", "-y", package], PackageCommands.Install(package));
        Assert.Equal($"sudo apt install '{package}'", PackageCommands.ByHand(package));
        Assert.Equal("while kill -0 4242 2>/dev/null; do sleep 0.2; done; exec /usr/bin/termilly", PackageCommands.RestartScript(4242));
    }

    [Fact]
    public void The_command_by_hand_quotes_a_path_with_a_quote()
    {
        var command = PackageCommands.ByHand(Path.Combine(_folder, "it's.deb"));

        Assert.StartsWith("sudo apt install '", command, StringComparison.Ordinal);
        Assert.EndsWith(@"it'\''s.deb'", command, StringComparison.Ordinal);
    }

    private static UpdatePackage Package(byte[] body) =>
        new(new Uri("https://termilly.com/downloads/1.2.0/TermillySetup-1.2.0-online.exe"), Convert.ToHexString(SHA256.HashData(body)).ToLowerInvariant());

    private static HttpClient Serving(byte[] body) => new(new Answer(_ => new HttpResponseMessage(HttpStatusCode.OK) { Content = new ByteArrayContent(body) }));

    private sealed class Answer(Func<HttpRequestMessage, HttpResponseMessage> answer) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) =>
            Task.FromResult(answer(request));
    }

    private sealed class Percents(Action<int> report) : IProgress<int>
    {
        public void Report(int value) => report(value);
    }
}
