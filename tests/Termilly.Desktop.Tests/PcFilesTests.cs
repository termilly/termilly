using System.IO;
using System.Net;
using System.Text;
using Termilly.Desktop.Features;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Copy to another Termilly computer (Features/RemotePcFiles.cs, Phone/PcFilesApi.cs): what's taken and what isn't.</summary>
public sealed class PcFilesTests
{
    [Theory]
    [InlineData("pc:abc:tmv1", true)]
    [InlineData("tmv1", false)]
    [InlineData(null, false)]
    public void Another_computers_terminal_is_told_by_its_id(string? id, bool remote) => Assert.Equal(remote, RemotePcFiles.Is(id));

    [Theory]
    [InlineData("notes.txt", true)]
    [InlineData("a folder", true)]
    [InlineData("..", false)]
    [InlineData(".", false)]
    [InlineData("", false)]
    [InlineData("../evil", false)]
    [InlineData("sub\\x", false)]
    public void Only_a_name_is_taken_never_a_path(string name, bool ok) => Assert.Equal(ok, FilesHandler.IsFileName(name));

    [Fact]
    public void Folder_and_name_pass_in_base64_and_junk_is_no_name()
    {
        Assert.Equal(@"C:\Users\me\Été", PcFiles.Decode(PcFiles.Encode(@"C:\Users\me\Été")));
        Assert.Null(PcFiles.Decode("not base64!"));
    }

    private sealed class Settings(bool allowTyping) : ISettingsStore
    {
        public AppSettings Current { get; } = new() { Phone = new PhoneSettings { AllowTyping = allowTyping } };
#pragma warning disable CS0067 // never raised here
        public event Action<SettingsSaved>? Saved;
#pragma warning restore CS0067
        public void Save(AppSettings settings) => throw new NotSupportedException();
    }

    [Fact]
    public async Task Nothing_is_listed_or_taken_while_typing_from_other_devices_is_off()
    {
        var api = new PcFilesApi(null!, new Settings(allowTyping: false));
        var list = api.Answer(new PhoneRequest("POST", PcFiles.List, [], Encoding.UTF8.GetBytes("""{"pane":"t1","path":"C:\\"}""")));
        Assert.Equal(HttpStatusCode.Conflict, list.Status);
        Assert.Contains("Allow typing", Encoding.UTF8.GetString(list.Content), StringComparison.Ordinal);

        var headers = new Dictionary<string, string> { [PcFiles.Headers.Pane] = "t1", [PcFiles.Headers.Dir] = PcFiles.Encode(@"C:\"), [PcFiles.Headers.Name] = PcFiles.Encode("a.txt"), [PcFiles.Headers.Length] = "3" };
        using var body = new MemoryStream([1, 2, 3]);
        var put = await api.UploadAsync(new PhoneRequest("PUT", PcFiles.Put, headers, []), body, CancellationToken.None);
        Assert.Equal(HttpStatusCode.Conflict, put.Status);
    }

    [Fact]
    public async Task An_upload_named_as_a_path_is_refused()
    {
        var api = new PcFilesApi(null!, new Settings(allowTyping: true));
        var headers = new Dictionary<string, string> { [PcFiles.Headers.Pane] = "t1", [PcFiles.Headers.Dir] = PcFiles.Encode(@"C:\"), [PcFiles.Headers.Name] = PcFiles.Encode(@"..\evil"), [PcFiles.Headers.Length] = "3" };
        using var body = new MemoryStream([1, 2, 3]);
        var put = await api.UploadAsync(new PhoneRequest("PUT", PcFiles.Put, headers, []), body, CancellationToken.None);
        Assert.Equal(HttpStatusCode.BadRequest, put.Status);
    }
}

/// <summary>Computers attach one way: one this computer shows can't pair to show this one (Phone/PhoneAppApi.cs).</summary>
public sealed class OneWayPairingTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly PhoneStore _store;

    public OneWayPairingTests() => _store = new PhoneStore(Termilly.Desktop.Security.Vault.Open(_dir));

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static PhoneReply? Pair(PhoneAppApi api, string code, string? computer) => api.Answer(new PhoneRequest("POST", "/api/pair", [],
        Encoding.UTF8.GetBytes(new System.Text.Json.Nodes.JsonObject { ["code"] = code, ["name"] = "LAPTOP (Termilly)", ["computer"] = computer }.ToJsonString())));

    [Fact]
    public void A_computer_this_one_shows_is_refused_and_the_code_still_works_for_another()
    {
        var api = new PhoneAppApi(_store, "key", _ => Task.CompletedTask, attachedTo: fp => fp == "AB12" ? "LAPTOP" : null);
        var code = _store.OfferCode();

        var refused = Pair(api, code, "AB12");
        Assert.Equal(HttpStatusCode.Conflict, refused?.Status);
        Assert.Contains("LAPTOP already shows this computer", Encoding.UTF8.GetString(refused!.Value.Content), StringComparison.Ordinal);

        var paired = Pair(api, code, "CD34");
        Assert.Equal(HttpStatusCode.OK, paired?.Status);
        Assert.Contains(Environment.MachineName, Encoding.UTF8.GetString(paired!.Value.Content), StringComparison.Ordinal);
    }
}
