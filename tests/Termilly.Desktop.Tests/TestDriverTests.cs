using System.Collections.Concurrent;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Text.Json;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

public sealed class TestDriverTests
{
    [Theory]
    [InlineData(0, null)]
    [InlineData(12345, null)]
    [InlineData(12345, "")]
    [InlineData(0, "secret")]
    public void Both_settings_are_required(int port, string? token) => Assert.False(new TestDriverOptions(port, token).Enabled);

    [Fact]
    public void Disabled_driver_does_not_bind_a_listener()
    {
        using var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        using var driver = new TestDriver(new PageChannel(new Sink()), new TestDriverOptions(port));
        driver.Start();
    }

    [Fact]
    public void Missing_and_wrong_tokens_are_rejected_and_ready_waits_for_the_page()
    {
        using var fixture = new Fixture();
        Assert.False(fixture.Driver.Authorized(null));
        Assert.False(fixture.Driver.Authorized("wrong"));
        Assert.True(fixture.Driver.Authorized(Fixture.Token));
        Assert.Empty(fixture.Sink.Sent);
        Assert.False(fixture.Driver.Ready);
        fixture.Dispatch("""{"type":"test:ready"}""");
        Assert.True(fixture.Driver.Ready);
    }

    [Fact]
    public async Task Requests_need_the_token_and_a_known_path_and_ready_says_whether_the_page_is()
    {
        using var fixture = new Fixture();
        static LoopbackRequest Get(string path, string? token) =>
            new("GET", path, token is null ? new Dictionary<string, string>() : new() { ["x-termilly-test-token"] = token }, []);
        Assert.Equal(HttpStatusCode.Forbidden, (await fixture.Driver.HandleAsync(Get("/ready", "wrong"))).Code);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await fixture.Driver.HandleAsync(Get("/ready", Fixture.Token))).Code);
        fixture.Dispatch("""{"type":"test:ready"}""");
        Assert.Equal(HttpStatusCode.OK, (await fixture.Driver.HandleAsync(Get("/ready", Fixture.Token))).Code);
        Assert.Equal(HttpStatusCode.NotFound, (await fixture.Driver.HandleAsync(Get("/other", Fixture.Token))).Code);
    }

    [Fact]
    public async Task The_loopback_server_answers_over_a_real_connection_and_one_waiting_from_the_start()
    {
        using var reservation = new TcpListener(IPAddress.Loopback, 0);
        reservation.Start();
        var port = ((IPEndPoint)reservation.LocalEndpoint).Port;
        reservation.Stop();
        using var server = new LoopbackHttp(port, request => Task.FromResult(new LoopbackResponse(HttpStatusCode.OK,
            JsonSerializer.Serialize(new { request.Method, request.Path, Body = System.Text.Encoding.UTF8.GetString(request.Body) }))));
        server.Start();
        using var http = new HttpClient();
        // Several at once, as a test polling /ready right after the app starts: none may bring it down.
        var answers = await Task.WhenAll(Enumerable.Range(0, 8).Select(i =>
            http.PostAsync($"http://127.0.0.1:{port}/eval?x={i}", new StringContent($"body {i}"))));
        Assert.All(answers, a => Assert.Equal(HttpStatusCode.OK, a.StatusCode));
        var json = await answers[3].Content.ReadAsStringAsync();
        Assert.Contains("\"Path\":\"/eval\"", json);
        Assert.Contains("\"Body\":\"body 3\"", json);
    }

    [Fact]
    public async Task An_unanswered_evaluation_times_out()
    {
        using var fixture = new Fixture();
        var result = await fixture.Driver.EvaluateAsync(new TestDriver.TestEvalRequest("await never", 1));
        Assert.Contains("timed out", result!.Error);
        Assert.NotEmpty(result.Id);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("message and stack")]
    public async Task The_page_result_is_relayed_with_its_id_value_and_error(string? error)
    {
        using var fixture = new Fixture();
        var responseTask = fixture.Driver.EvaluateAsync(new TestDriver.TestEvalRequest("return { answer: 42 }"));
        var sent = await Task.Run(() => fixture.Sink.Sent.TryTake(out var json, TimeSpan.FromSeconds(5)) ? json : null);
        Assert.NotNull(sent);
        using var message = JsonDocument.Parse(sent);
        var id = message.RootElement.GetProperty("id").GetString();
        Assert.Equal("test:eval", message.RootElement.GetProperty("type").GetString());
        Assert.Equal("return { answer: 42 }", message.RootElement.GetProperty("code").GetString());
        fixture.Dispatch(JsonSerializer.Serialize(new { type = "test:result", id, value = new { answer = 42 }, error }));
        var result = await responseTask;
        Assert.Equal(id, result!.Id);
        Assert.Equal(42, result.Value!.Value.GetProperty("answer").GetInt32());
        Assert.Equal(error, result.Error);
    }

    private sealed class Sink : IPageSink
    {
        public BlockingCollection<string> Sent { get; } = [];
        public void Send(string json) => Sent.Add(json);
    }

    private sealed class Fixture : IDisposable
    {
        public const string Token = "test secret";
        public Sink Sink { get; } = new();
        public TestDriver Driver { get; }
        private readonly MessageRouter _router = new(PageChannel.Json);
        public Fixture()
        {
            Driver = new TestDriver(new PageChannel(Sink), new TestDriverOptions(12345, Token));
            Driver.Register(_router);
        }

        public void Dispatch(string json)
        {
            using var document = JsonDocument.Parse(json);
            Assert.True(_router.Dispatch(document.RootElement, null));
        }

        public void Dispose()
        {
            Driver.Dispose();
            Sink.Sent.Dispose();
        }
    }
}
