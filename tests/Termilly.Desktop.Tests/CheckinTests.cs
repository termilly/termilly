using System.IO;
using System.Net;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

[Collection("Environment")]
public sealed class CheckinTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly string _web;
    private readonly List<string> _ops = [];
    private CheckinDevices _devices;

    public CheckinTests()
    {
        _devices = new CheckinDevices(Vault.Open(_dir));
        _web = Path.Combine(_dir, "phone");
        Directory.CreateDirectory(_web);
        File.WriteAllText(Path.Combine(_web, "index.html"), "<p>phone</p>");
        Environment.SetEnvironmentVariable("TERMILLY_CHECKIN_BIND", "127.0.0.1");
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable("TERMILLY_CHECKIN_BIND", null);
        Directory.Delete(_dir, recursive: true);
    }

    private CheckinServer Server() => CheckinServer.Start(0, _web, (op, args) =>
    {
        _ops.Add(op);
        return Task.FromResult<JsonNode?>(new JsonObject { ["echo"] = op });
    }, _devices);

    private static string Request(string id, byte[] key, string op, long? at = null, byte[]? nonce = null)
    {
        var plaintext = new JsonObject { ["t"] = at ?? DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), ["op"] = op }.ToJsonString();
        nonce ??= RandomNumberGenerator.GetBytes(12);
        var data = Encoding.UTF8.GetBytes(plaintext);
        var sealedBytes = new byte[data.Length + 16];
        using (var gcm = new AesGcm(key, 16))
        {
            gcm.Encrypt(nonce, data, sealedBytes.AsSpan(0, data.Length), sealedBytes.AsSpan(data.Length), Encoding.UTF8.GetBytes(id));
        }
        return new JsonObject { ["d"] = id, ["n"] = Convert.ToBase64String(nonce), ["c"] = Convert.ToBase64String(sealedBytes) }.ToJsonString();
    }

    private static JsonNode Reply(string answer, string id, byte[] key)
    {
        var reply = JsonNode.Parse(answer)!;
        return JsonNode.Parse(CheckinServer.Open(key, Convert.FromBase64String(reply["n"]!.GetValue<string>()),
            Convert.FromBase64String(reply["c"]!.GetValue<string>()), id))!;
    }

    [Fact]
    public async Task A_paired_phone_gets_answers_and_everyone_else_gets_nothing()
    {
        using var server = Server();
        var (id, key) = _devices.Offer();

        var answer = await server.HandleApi(Request(id, key, "state"), "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0)");
        Assert.Equal("state", Reply(answer!, id, key)["result"]!["echo"]!.GetValue<string>());
        Assert.Equal("iPhone", Assert.Single(_devices.List()).Name); // the first request completes the pairing

        Assert.Null(await server.HandleApi(Request(id, RandomNumberGenerator.GetBytes(32), "state"), null)); // wrong key
        Assert.Null(await server.HandleApi(Request("0123456789abcdef", key, "state"), null)); // unknown phone
        Assert.Null(await server.HandleApi(Request(id, key, "state", at: DateTimeOffset.UtcNow.AddMinutes(-5).ToUnixTimeMilliseconds()), null)); // old
        Assert.Null(await server.HandleApi("not json", null));

        var once = Request(id, key, "output");
        Assert.NotNull(await server.HandleApi(once, null));
        Assert.Null(await server.HandleApi(once, null)); // a replay

        _devices.Remove(id);
        Assert.Null(await server.HandleApi(Request(id, key, "state"), null));
        Assert.Equal(["state", "output"], _ops);
    }

    [Fact]
    public async Task Keys_are_stored_sealed_and_pairings_survive_a_restart()
    {
        using var server = Server();
        var (id, key) = _devices.Offer();
        await server.HandleApi(Request(id, key, "state"), null);

        var file = File.ReadAllText(Path.Combine(_dir, "checkin.json"));
        Assert.DoesNotContain(Convert.ToBase64String(key), file);

        _devices = new CheckinDevices(Vault.Open(_dir)); // as after a restart
        Assert.NotNull(await server.HandleApi(Request(id, key, "state"), null));
    }

    [Fact]
    public async Task The_server_hands_out_only_the_phone_page_and_refuses_the_rest()
    {
        using var server = Server();
        using var http = new HttpClient { BaseAddress = new Uri(server.BaseUrl) };

        var page = await http.GetAsync("/");
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.Contains("default-src 'none'", page.Headers.GetValues("Content-Security-Policy").Single());
        Assert.Equal("<p>phone</p>", await page.Content.ReadAsStringAsync());

        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/..%2Fcheckin.json")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync("/missing.js")).StatusCode);
        var probe = await http.PostAsync("/api", new StringContent("{\"d\":\"x\"}"));
        Assert.Equal(HttpStatusCode.Forbidden, probe.StatusCode);
        Assert.Empty(await probe.Content.ReadAsStringAsync());
    }

    [Theory]
    [InlineData("192.168.1.20", true)]
    [InlineData("10.0.0.5", true)]
    [InlineData("172.20.1.1", true)]
    [InlineData("172.32.0.1", false)]
    [InlineData("8.8.8.8", false)]
    [InlineData("127.0.0.1", false)]
    public void Only_private_addresses_count_as_the_local_network(string address, bool local) =>
        Assert.Equal(local, CheckinServer.IsPrivate(IPAddress.Parse(address)));
}
