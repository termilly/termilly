using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Security;
using System.Net.WebSockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Security;

namespace Termilly.Desktop.Tests;

[Collection("Environment")]
public sealed class PhoneTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly string _web;
    private readonly Vault _vault;
    private readonly PhoneStore _store;
    private readonly List<string> _alerts = [];
    private readonly PhoneLive _live = new();

    public PhoneTests()
    {
        _vault = Vault.Open(_dir);
        _store = new PhoneStore(_vault);
        _web = Path.Combine(_dir, "phone");
        Directory.CreateDirectory(_web);
        File.WriteAllText(Path.Combine(_web, "index.html"), "<p>app</p>");
        File.WriteAllText(Path.Combine(_web, "setup.html"), "<p>setup</p>");
        Environment.SetEnvironmentVariable("TERMILLY_PHONE_BIND", "127.0.0.1");
    }

    public void Dispose()
    {
        _live.Dispose();
        Environment.SetEnvironmentVariable("TERMILLY_PHONE_BIND", null);
        Directory.Delete(_dir, recursive: true);
    }

    // ---- Web Push ----

    [Fact]
    public void Alerts_are_encrypted_exactly_as_RFC_8291_says()
    {
        // RFC 8291, Appendix A.
        var plaintext = Encoding.UTF8.GetBytes("When I grow up, I want to be a watermelon");
        var sender = Key("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
        var phonePublic = WebPush.FromBase64Url("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        var auth = WebPush.FromBase64Url("BTBZMqHH6r4Tts7J_aSIgg");
        var salt = WebPush.FromBase64Url("DGv6ra1nlYgDCS1FRnbzlw");

        var body = WebPush.Encrypt(plaintext, phonePublic, auth, sender, salt);

        Assert.Equal("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
            WebPush.Base64Url(body));
    }

    [Fact]
    public void A_phone_opens_an_alert_with_its_own_key()
    {
        using var phone = ECDiffieHellman.Create(ECCurve.NamedCurves.nistP256);
        var phonePublic = Point(phone.ExportParameters(false));
        var auth = RandomNumberGenerator.GetBytes(16);

        var body = WebPush.Encrypt(Encoding.UTF8.GetBytes("""{"title":"Needs you"}"""), phonePublic, auth);

        Assert.Equal("""{"title":"Needs you"}""", Decrypt(body, phone, phonePublic, auth));
    }

    [Fact]
    public void The_sender_token_is_signed_with_Termillys_key()
    {
        using var vapid = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        var token = WebPush.Token(vapid, "https://web.push.apple.com", DateTimeOffset.UtcNow.AddHours(1));
        var parts = token.Split('.');

        Assert.Equal(3, parts.Length);
        Assert.Contains("\"aud\":\"https://web.push.apple.com\"", Encoding.UTF8.GetString(WebPush.FromBase64Url(parts[1])));
        Assert.True(vapid.VerifyData(Encoding.ASCII.GetBytes($"{parts[0]}.{parts[1]}"), WebPush.FromBase64Url(parts[2]), HashAlgorithmName.SHA256,
            DSASignatureFormat.IeeeP1363FixedFieldConcatenation));
        Assert.Equal(65, WebPush.FromBase64Url(WebPush.PublicKey(vapid)).Length);
    }

    [Theory]
    [InlineData("https://web.push.apple.com/QGuQ", true)]
    [InlineData("https://fcm.googleapis.com/fcm/send/abc", true)]
    [InlineData("https://wns2-db5p.notify.windows.com/w/?token=x", true)]
    [InlineData("http://fcm.googleapis.com/fcm/send/abc", false)]
    [InlineData("https://192.168.1.10/steal", false)]
    [InlineData("https://evil.com/.push.apple.com", false)]
    [InlineData("not a url", false)]
    public void Alerts_go_only_to_known_push_services(string endpoint, bool allowed) =>
        Assert.Equal(allowed, PhoneAppApi.IsPushService(endpoint));

    // ---- Agent alerts ----

    [Theory]
    [InlineData("always", true, 0, true)]
    [InlineData("off", false, 600, false)]
    [InlineData("away", false, 0, true)] // Termilly isn't in front
    [InlineData("away", true, 10, false)] // in front, and the user was just here
    [InlineData("away", true, 61, true)] // in front, but nobody has touched the PC for a minute
    public void Alerts_go_out_as_Settings_says(string mode, bool inFront, int idleSeconds, bool sent) =>
        Assert.Equal(sent, Features.PhoneHandler.ShouldAlert(mode, inFront, TimeSpan.FromSeconds(idleSeconds)));

    [Fact]
    public void Away_without_knowing_the_idle_time_goes_by_the_window_alone()
    {
        Assert.False(Features.PhoneHandler.ShouldAlert("away", true, null));
        Assert.True(Features.PhoneHandler.ShouldAlert("away", false, null));
    }

    [Fact]
    public void An_alert_carries_the_news_without_secrets_cut_short_and_one_per_terminal()
    {
        var news = new Messaging.FromPage.PhoneAlert("t1", "done", "Finished: api · backend", "Deployed with token ghp_" + new string('a', 36) + " " + new string('x', 300));

        var alert = Features.PhoneHandler.AlertFor(news, hideDetails: false);

        Assert.Equal("Finished: api · backend", alert["title"]!.GetValue<string>());
        Assert.DoesNotContain("ghp_aaaa", alert["body"]!.GetValue<string>());
        Assert.True(alert["body"]!.GetValue<string>().Length <= 180);
        Assert.Equal("t1", alert["tag"]!.GetValue<string>());
    }

    [Fact]
    public void Hidden_details_say_only_what_happened()
    {
        var done = Features.PhoneHandler.AlertFor(new Messaging.FromPage.PhoneAlert("t1", "done", "Finished: api · backend", "secret plan"), hideDetails: true);
        var waiting = Features.PhoneHandler.AlertFor(new Messaging.FromPage.PhoneAlert("t2", "needs-input", "Needs you: db · ops", "Allow Bash?"), hideDetails: true);

        Assert.Equal("An agent finished.", done["body"]!.GetValue<string>());
        Assert.Equal("An agent needs you.", waiting["body"]!.GetValue<string>());
        Assert.DoesNotContain("api", done.ToJsonString());
        Assert.DoesNotContain("db", waiting.ToJsonString());
    }

    // ---- Certificates ----

    [Fact]
    public void The_server_certificate_names_this_PCs_address_and_chains_to_Termillys_authority()
    {
        using var authority = PhoneCertificates.CreateAuthority("TESTPC");
        using var server = PhoneCertificates.IssueServer(authority, [IPAddress.Parse("192.168.1.20")], "testpc.local");

        Assert.True(server.HasPrivateKey);
        Assert.True(server.MatchesHostname("192.168.1.20"));
        Assert.True(server.MatchesHostname("testpc.local"));
        Assert.False(server.MatchesHostname("192.168.1.21"));
        Assert.True((server.NotAfter - server.NotBefore).TotalDays <= 825);
        using var chain = new X509Chain();
        chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
        chain.ChainPolicy.CustomTrustStore.Add(authority);
        chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
        Assert.True(chain.Build(server));
    }

    [Fact]
    public void The_authority_is_kept_sealed_and_the_same_after_a_restart()
    {
        using var first = _store.Authority("TESTPC");
        var again = new PhoneStore(_vault);
        using var second = again.Authority("TESTPC");

        Assert.Equal(first.Thumbprint, second.Thumbprint);
        Assert.True(second.HasPrivateKey);
        Assert.DoesNotContain("Authority", File.ReadAllText(_vault.PathOf("phone.json")));
    }

    [Fact]
    public void A_restart_keeps_the_server_certificate_and_a_new_address_gets_a_new_one()
    {
        using var authority = _store.Authority("TESTPC");
        IPAddress[] here = [IPAddress.Parse("192.168.1.20")];
        using var first = _store.ServerCertificate(authority, here, "testpc.local");

        using var afterRestart = new PhoneStore(_vault).ServerCertificate(authority, here, "testpc.local");
        using var elsewhere = new PhoneStore(_vault).ServerCertificate(authority, [IPAddress.Parse("10.0.0.7")], "testpc.local");

        Assert.Equal(first.Thumbprint, afterRestart.Thumbprint);
        Assert.NotEqual(first.Thumbprint, elsewhere.Thumbprint);
        Assert.True(elsewhere.MatchesHostname("10.0.0.7"));
    }

    // ---- Pairing ----

    [Fact]
    public void A_code_pairs_one_phone_once_and_its_token_survives_a_restart()
    {
        Assert.Null(_store.Pair("WRONG123", "iPhone"));
        var code = _store.OfferCode();

        var token = _store.Pair(code.ToLowerInvariant(), "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)");

        Assert.NotNull(token);
        Assert.Null(_store.Pair(code, "Android"));
        var restarted = new PhoneStore(_vault);
        Assert.NotNull(restarted.DeviceFor(token));
        Assert.Equal("iPhone", Assert.Single(restarted.List()).Name);
        Assert.Null(restarted.DeviceFor("not-a-token"));
        Assert.DoesNotContain(token!, File.ReadAllText(_vault.PathOf("phone.json")));
    }

    [Fact]
    public void A_phone_paired_again_under_its_name_replaces_its_old_entry()
    {
        const string iPhone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4)";
        var first = _store.Pair(_store.OfferCode(), iPhone, "Work iPhone");
        _store.Pair(_store.OfferCode(), iPhone, "Home iPhone");
        _store.Pair(_store.OfferCode(), iPhone, "  work IPHONE\n");
        var unnamed = _store.Pair(_store.OfferCode(), iPhone, "   ");

        Assert.Null(_store.DeviceFor(first)); // its entry went
        Assert.Equal(["Home iPhone", "work IPHONE", "iPhone"], _store.List().Select(d => d.Name));
        Assert.NotNull(_store.DeviceFor(unnamed));
        _store.Pair(_store.OfferCode(), iPhone, new string('x', 99));
        Assert.Equal(40, _store.List()[^1].Name.Length);
    }

    [Fact]
    public void Too_many_wrong_codes_withdraw_the_pairing()
    {
        var code = _store.OfferCode();
        for (var i = 0; i < 10; i++)
        {
            Assert.Null(_store.Pair("AAAAAAAA", null));
        }
        Assert.Null(_store.Pair(code, null));
    }

    [Theory]
    [InlineData("192.168.1.5", true)]
    [InlineData("10.0.0.2", true)]
    [InlineData("172.20.1.1", true)]
    [InlineData("100.101.102.103", true)]
    [InlineData("172.32.0.1", false)]
    [InlineData("8.8.8.8", false)]
    [InlineData("100.128.0.1", false)]
    public void Only_private_addresses_count_as_the_local_network(string address, bool isPrivate) =>
        Assert.Equal(isPrivate, PhoneServer.IsPrivate(IPAddress.Parse(address)));

    [Theory]
    [InlineData("192.168.0.5", "195.82.43.128,192.168.0.5")] // a private one first
    [InlineData("195.82.43.128", "127.0.0.1,169.254.10.1,195.82.43.128")] // a cloud machine's public one
    [InlineData("11.0.0.4", "::1,11.0.0.4")] // a cloud network on any subnet
    [InlineData(null, "127.0.0.1,169.254.10.1,::1")]
    public void The_address_to_listen_on_is_a_private_one_else_any_other(string? picked, string addresses) =>
        Assert.Equal(picked, PhoneServer.Pick(addresses.Split(',').Select(a => IPAddress.Parse(a)))?.ToString());

    [Theory]
    [InlineData("open", false, true, false, null)]
    [InlineData("open", true, false, true, "Allow opening")]
    [InlineData("newWorkspace", true, false, true, "Allow opening")]
    [InlineData("close", false, false, true, null)]
    [InlineData("close", true, true, false, "Allow closing")]
    [InlineData("closeWorkspace", true, true, false, "Allow closing")]
    [InlineData("rename", false, true, true, "Allow typing")]
    [InlineData("rename", true, false, false, null)]
    [InlineData("clearNote", false, false, false, null)]
    public void What_a_device_may_do_follows_its_own_setting(string action, bool typing, bool opening, bool closing, string? refused) =>
        Assert.Equal(refused, Features.PhoneHandler.Refused(action, new PhoneSettings { AllowTyping = typing, AllowOpening = opening, AllowClosing = closing }));

    [Theory]
    [InlineData(true, true)]
    [InlineData(false, false)]
    public void Opening_and_closing_start_as_typing_was_so_a_phone_keeps_what_it_could_do(bool typing, bool starts)
    {
        var phone = new PhoneSettings { AllowTyping = typing }.Normalize();

        Assert.Equal(starts, phone.AllowOpening);
        Assert.Equal(starts, phone.AllowClosing);
    }

    [Fact]
    public void Turning_typing_on_later_doesnt_turn_opening_or_closing_on()
    {
        var phone = (new PhoneSettings().Normalize() with { AllowTyping = true }).Normalize();

        Assert.False(phone.AllowOpening);
        Assert.False(phone.AllowClosing);
    }

    // ---- The server ----

    [Fact]
    public async Task Plain_http_hands_out_only_the_setup_page_and_the_certificate()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = new HttpClient();

        Assert.Contains("setup", await http.GetStringAsync(server.SetupUrl));
        var certificate = await http.GetByteArrayAsync(server.SetupUrl + "termilly.cer");
        Assert.Equal(authority.Thumbprint, X509CertificateLoader.LoadCertificate(certificate).Thumbprint);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(server.SetupUrl + "index.html")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(server.SetupUrl + "api/me")).StatusCode);
    }

    [Fact]
    public async Task Over_https_only_a_paired_phone_gets_in()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var me = server.AppUrl + "api/me";

        Assert.Contains("app", await http.GetStringAsync(server.AppUrl));
        Assert.False(JsonNode.Parse(await http.GetStringAsync(me))!["paired"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.Forbidden, (await Post(http, server.AppUrl + "api/push", """{"endpoint":"https://fcm.googleapis.com/x","keys":{"p256dh":"a","auth":"b"}}""")).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await Post(http, server.AppUrl + "api/pair", """{"code":"WRONG123"}""")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await http.GetAsync(server.AppUrl + "..%2F..%2Fphone.json")).StatusCode);

        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        Assert.Equal(HttpStatusCode.OK, paired.StatusCode);
        Assert.Contains("HttpOnly", string.Join(";", paired.Headers.GetValues("Set-Cookie")));
        Assert.True(JsonNode.Parse(await http.GetStringAsync(me))!["paired"]!.GetValue<bool>());
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(http, server.AppUrl + "api/push", """{"endpoint":"https://example.com/x","keys":{"p256dh":"a","auth":"b"}}""")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await Post(http, server.AppUrl + "api/push", """{"endpoint":"https://fcm.googleapis.com/x","keys":{"p256dh":"a","auth":"b"}}""")).StatusCode);
        Assert.True(Assert.Single(_store.List()).Alerts);
    }

    [Fact]
    public async Task A_paired_phone_gets_the_terminals_live_and_its_answers_reach_the_PC()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        var cookie = paired.Headers.GetValues("Set-Cookie").First().Split(';')[0];
        _live.SetState("""{"terminals":[{"id":"t1"}]}""");
        _live.Received = (device, message) => Task.FromResult(new JsonObject { ["ok"] = true, ["choice"] = message["choice"]?.DeepClone() });

        using var phone = Socket(authority, cookie);
        await phone.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
        Assert.Contains("\"t1\"", await ReceiveText(phone));
        _live.SetState("""{"terminals":[{"id":"t2"}]}""");
        Assert.Contains("\"t2\"", await ReceiveText(phone));
        await phone.SendAsync(Encoding.UTF8.GetBytes("""{"op":"answer","pane":"t2","choice":"approve"}"""), WebSocketMessageType.Text, true, CancellationToken.None);
        var answered = JsonNode.Parse(await ReceiveText(phone))!;
        Assert.Equal(("answered", "approve"), (answered["type"]!.GetValue<string>(), answered["choice"]!.GetValue<string>()));

        // Watching a terminal: what it shows first, then what it prints, in one batch; what it prints while the
        // window draws the screen comes after the screen, not before.
        _live.Screen = async pane =>
        {
            _live.Output(pane, "while drawing, ");
            await Task.Delay(200);
            return pane == "t2" ? "what it shows" : "";
        };
        await phone.SendAsync(Encoding.UTF8.GetBytes("""{"op":"watch","pane":"t2"}"""), WebSocketMessageType.Text, true, CancellationToken.None);
        var screen = JsonNode.Parse(await ReceiveText(phone))!;
        Assert.Equal(("screen", "what it shows"), (screen["type"]!.GetValue<string>(), screen["data"]!.GetValue<string>()));
        _live.Output("t1", "not watched");
        _live.Output("t2", "new ");
        _live.Output("t2", "line");
        // Output goes out every few milliseconds: it may come in more than one piece, but in order, after the screen.
        var printed = "";
        while (printed.Length < "while drawing, new line".Length)
        {
            var output = JsonNode.Parse(await ReceiveText(phone))!;
            Assert.Equal("output", output["type"]!.GetValue<string>());
            printed += output["data"]!.GetValue<string>();
        }
        Assert.Equal("while drawing, new line", printed);

        // Drawn at another size there: what it shows, again.
        _live.Screen = pane => Task.FromResult("redrawn");
        await phone.SendAsync(Encoding.UTF8.GetBytes("""{"op":"refresh"}"""), WebSocketMessageType.Text, true, CancellationToken.None);
        var again = JsonNode.Parse(await ReceiveText(phone))!;
        Assert.Equal(("screen", "t2", "redrawn"), (again["type"]!.GetValue<string>(), again["pane"]!.GetValue<string>(), again["data"]!.GetValue<string>()));

        using var stranger = Socket(authority, "termilly=not-a-token");
        await Assert.ThrowsAnyAsync<WebSocketException>(() => stranger.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None));
    }

    [Fact]
    public async Task A_phone_unpairs_itself_and_is_a_stranger_after()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}","name":"Test phone"}""");
        Assert.Contains("\"paired\":true", await http.GetStringAsync(server.AppUrl + "api/me"));

        var forgot = await Post(http, server.AppUrl + "api/forget", "{}");

        Assert.Equal(HttpStatusCode.OK, forgot.StatusCode);
        Assert.Empty(_store.List());
        Assert.Contains("\"paired\":false", await http.GetStringAsync(server.AppUrl + "api/me"));
        Assert.Equal(HttpStatusCode.Forbidden, (await Post(http, server.AppUrl + "api/forget", "{}")).StatusCode);
    }

    [Fact]
    public async Task A_terminal_takes_the_size_of_the_phone_watching_it_with_which_phone_and_its_own_back_when_the_phone_goes()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        var cookie = paired.Headers.GetValues("Set-Cookie").First().Split(';')[0];
        var sized = new List<(string Pane, PhoneLive.Viewer? Phone)>();
        var released = new TaskCompletionSource();
        _live.Sized = (pane, phone) =>
        {
            lock (sized)
            {
                sized.Add((pane, phone));
            }
            if (phone is null)
            {
                released.TrySetResult();
            }
        };
        using var phone = Socket(authority, cookie);
        await phone.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
        await ReceiveText(phone); // the terminals

        await Send(phone, """{"op":"watch","pane":"t1"}""");
        await ReceiveText(phone); // the screen
        await Send(phone, """{"op":"size","pane":"t2","cols":50,"rows":30}"""); // not the one it watches
        await Send(phone, """{"op":"size","pane":"t1","cols":5000,"rows":30}""");
        await Send(phone, """{"op":"unwatch"}""");
        await released.Task.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.Equal(2, sized.Count);
        Assert.Equal(("t1", new PhoneLive.GridSize(400, 30), "127.0.0.1"), (sized[0].Pane, sized[0].Phone!.Size, sized[0].Phone!.Address));
        Assert.Equal(_store.List().Single().Id, sized[0].Phone!.Device);
        Assert.Equal(("t1", null), sized[1]);
    }

    [Fact]
    public async Task A_computer_gives_its_size_up_and_the_PC_takes_a_terminal_back_telling_the_one_that_gave_it()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        var cookie = paired.Headers.GetValues("Set-Cookie").First().Split(';')[0];
        var sized = new List<PhoneLive.Viewer?>();
        _live.Sized = (_, viewer) =>
        {
            lock (sized)
            {
                sized.Add(viewer);
            }
        };
        using var phone = Socket(authority, cookie);
        await phone.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
        await ReceiveText(phone); // the terminals

        await Send(phone, """{"op":"watch","pane":"t1","cols":0,"rows":0}"""); // keeps the terminal's own size
        await ReceiveText(phone); // the screen
        await Send(phone, """{"op":"size","pane":"t1","cols":100,"rows":30}""");
        await Send(phone, """{"op":"size","pane":"t1","cols":0,"rows":0}"""); // its tab went off screen
        await Send(phone, """{"op":"size","pane":"t1","cols":90,"rows":30}""");
        await Until(() => { lock (sized) { return sized.Count == 3; } });
        _live.TakeBack("t1");
        var released = JsonNode.Parse(await ReceiveText(phone))!;
        _live.TakeBack("t1"); // nobody gives it a size now: nothing to tell

        Assert.Equal(("released", "t1", null), (released["type"]!.GetValue<string>(), released["pane"]!.GetValue<string>(), released["by"]?.GetValue<string>()));
        Assert.Equal([new PhoneLive.GridSize(100, 30), null, new PhoneLive.GridSize(90, 30), null], sized.Select(v => v?.Size));
    }

    [Fact]
    public async Task A_second_phone_giving_its_size_takes_the_terminal_and_the_first_is_told_who_has_it()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var first = (await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}","name":"Laptop"}""")).Headers.GetValues("Set-Cookie").First().Split(';')[0];
        var second = (await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}","name":"Phone"}""")).Headers.GetValues("Set-Cookie").First().Split(';')[0];
        _live.NameOf = device => _store.List().FirstOrDefault(d => d.Id == device)?.Name;
        var watchers = new List<string>();
        _live.Watchers = (pane, names) =>
        {
            lock (watchers)
            {
                watchers.Add($"{pane}: {string.Join(", ", names)}");
            }
        };
        var sized = new List<PhoneLive.GridSize?>();
        _live.Sized = (_, viewer) =>
        {
            lock (sized)
            {
                sized.Add(viewer?.Size);
            }
        };
        using var laptop = Socket(authority, first);
        using var phone = Socket(authority, second);
        foreach (var socket in new[] { laptop, phone })
        {
            await socket.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
            await ReceiveText(socket); // the terminals
            await Send(socket, """{"op":"watch","pane":"t1"}""");
            await ReceiveText(socket); // the screen
        }

        await Send(laptop, """{"op":"size","pane":"t1","cols":120,"rows":40}""");
        await Until(() => { lock (sized) { return sized.Count == 1; } });
        await Send(phone, """{"op":"size","pane":"t1","cols":50,"rows":30}""");
        var released = JsonNode.Parse(await ReceiveText(laptop))!;
        await Until(() => { lock (sized) { return sized.Count == 2; } });
        phone.Abort(); // the phone goes: nobody gives it a size now

        await Until(() => { lock (sized) { return sized.Count == 3; } });
        Assert.Equal(("released", "Phone"), (released["type"]!.GetValue<string>(), released["by"]!.GetValue<string>()));
        Assert.Equal([new PhoneLive.GridSize(120, 40), new PhoneLive.GridSize(50, 30), null], sized);
        await Until(() => { lock (watchers) { return watchers.Count == 3; } });
        Assert.Equal(["t1: Laptop", "t1: Laptop, Phone", "t1: Laptop"], watchers);
    }

    [Fact]
    public async Task A_phone_with_the_app_on_screen_counts_as_open_until_it_goes_to_the_background_or_disconnects()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        var cookie = paired.Headers.GetValues("Set-Cookie").First().Split(';')[0];
        var device = _store.List().Single().Id;
        Assert.False(_live.IsOpenOn(device));

        using var phone = Socket(authority, cookie);
        await phone.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
        await ReceiveText(phone); // the terminals
        Assert.True(_live.IsOpenOn(device));

        await Send(phone, """{"op":"seen","shown":false}""");
        await Until(() => !_live.IsOpenOn(device));
        await Send(phone, """{"op":"seen","shown":true}""");
        await Until(() => _live.IsOpenOn(device));

        phone.Abort(); // the app closed, or iOS ended it in the background
        await Until(() => !_live.IsOpenOn(device));
        Assert.False(_live.IsOpenOn("another-phone"));
    }

    [Fact]
    public async Task A_terminal_a_phone_opens_or_comes_back_to_counts_as_seen()
    {
        using var authority = _store.Authority("TESTPC");
        using var server = Start(authority);
        using var http = Https(authority);
        var paired = await Post(http, server.AppUrl + "api/pair", $$"""{"code":"{{_store.OfferCode()}}"}""");
        var cookie = paired.Headers.GetValues("Set-Cookie").First().Split(';')[0];
        var opened = new System.Collections.Concurrent.ConcurrentQueue<string>();
        _live.Opened = opened.Enqueue;

        using var phone = Socket(authority, cookie);
        await phone.ConnectAsync(new Uri(server.AppUrl.Replace("https", "wss") + "api/live"), CancellationToken.None);
        await ReceiveText(phone); // the terminals
        await Send(phone, """{"op":"watch","pane":"p1","cols":40,"rows":20}""");
        await Until(() => opened.Count == 1);
        Assert.True(_live.IsShownOnPhone("p1"));

        await Send(phone, """{"op":"seen","shown":false}"""); // locked, or another app
        await Until(() => !_live.IsShownOnPhone("p1"));
        await Send(phone, """{"op":"seen","shown":true}""");
        await Until(() => opened.Count == 2);
        Assert.Equal(["p1", "p1"], opened);
        Assert.False(_live.IsShownOnPhone("p2"));
    }

    private static async Task Until(Func<bool> condition)
    {
        for (var waited = 0; !condition(); waited += 20)
        {
            Assert.True(waited < 5000, "timed out");
            await Task.Delay(20);
        }
    }

    private static Task Send(ClientWebSocket socket, string text) =>
        socket.SendAsync(Encoding.UTF8.GetBytes(text), WebSocketMessageType.Text, true, CancellationToken.None);

    private static ClientWebSocket Socket(X509Certificate2 authority, string cookie)
    {
        var socket = new ClientWebSocket();
        socket.Options.SetRequestHeader("Cookie", cookie);
        socket.Options.RemoteCertificateValidationCallback = (_, certificate, _, _) =>
        {
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(authority);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return certificate is X509Certificate2 c && chain.Build(c);
        };
        return socket;
    }

    private static async Task<string> ReceiveText(ClientWebSocket socket)
    {
        var buffer = new byte[64 * 1024];
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        var result = await socket.ReceiveAsync(buffer, timeout.Token);
        return Encoding.UTF8.GetString(buffer, 0, result.Count);
    }

    private PhoneServer Start(X509Certificate2 authority) =>
        PhoneServer.Start(0, _web, _store, _live, authority, "key", device =>
        {
            _alerts.Add(device);
            return Task.CompletedTask;
        });

    /// <summary>A client that trusts Termilly's authority alone, as a phone does once it's installed, and keeps cookies.</summary>
    private static HttpClient Https(X509Certificate2 authority) => new(new HttpClientHandler
    {
        UseCookies = true,
        CookieContainer = new CookieContainer(),
        ServerCertificateCustomValidationCallback = (_, certificate, _, _) =>
        {
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(authority);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            return certificate is not null && chain.Build(certificate) && certificate.MatchesHostname("127.0.0.1");
        },
    });

    private static Task<HttpResponseMessage> Post(HttpClient http, string url, string json) =>
        http.PostAsync(url, new StringContent(json, Encoding.UTF8, "application/json"));

    private static ECDiffieHellman Key(string privateKey, string publicKey)
    {
        var point = WebPush.FromBase64Url(publicKey);
        return ECDiffieHellman.Create(new ECParameters
        {
            Curve = ECCurve.NamedCurves.nistP256,
            D = WebPush.FromBase64Url(privateKey),
            Q = new ECPoint { X = point[1..33], Y = point[33..65] },
        });
    }

    private static byte[] Point(ECParameters key) => [0x04, .. key.Q.X!, .. key.Q.Y!];

    /// <summary>What a browser does with an alert (RFC 8291), written out again here so the test doesn't trust the code it checks.</summary>
    private static string Decrypt(byte[] body, ECDiffieHellman phone, byte[] phonePublic, byte[] auth)
    {
        var salt = body[..16];
        var idLength = body[20];
        var senderPublic = body[21..(21 + idLength)];
        var sealedRecord = body[(21 + idLength)..];
        using var sender = ECDiffieHellman.Create(new ECParameters { Curve = ECCurve.NamedCurves.nistP256, Q = new ECPoint { X = senderPublic[1..33], Y = senderPublic[33..65] } });
        var shared = phone.DeriveRawSecretAgreement(sender.PublicKey);
        var ikm = HKDF.DeriveKey(HashAlgorithmName.SHA256, shared, 32, auth, [.. "WebPush: info\0"u8, .. phonePublic, .. senderPublic]);
        var key = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 16, salt, "Content-Encoding: aes128gcm\0"u8.ToArray());
        var nonce = HKDF.DeriveKey(HashAlgorithmName.SHA256, ikm, 12, salt, "Content-Encoding: nonce\0"u8.ToArray());
        var record = new byte[sealedRecord.Length - 16];
        using var gcm = new AesGcm(key, 16);
        gcm.Decrypt(nonce, sealedRecord[..^16], sealedRecord[^16..], record);
        return Encoding.UTF8.GetString(record[..Array.LastIndexOf(record, (byte)2)]);
    }
}
