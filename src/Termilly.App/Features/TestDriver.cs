using System.Collections.Concurrent;
using System.Net;
using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>Explicitly enabled loopback automation for an isolated test instance.</summary>
internal sealed class TestDriver(PageChannel page, TestDriverOptions options) : IMessageHandler, IStartable, IDisposable
{
    internal const string TokenHeader = "X-Termilly-Test-Token";
    private const string ReadyPath = "/ready";
    private const string EvalPath = "/eval";
    private const string GetMethod = "GET";
    private const string PostMethod = "POST";
    private const int DefaultTimeoutMs = 30000;
    private LoopbackHttp? _server;
    private readonly ConcurrentDictionary<string, TaskCompletionSource<FromPage.TestResult>> _calls = new();
    private volatile bool _ready;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.TestReady>(_ => _ready = true);
        router.On<FromPage.TestResult>(m =>
        {
            if (_calls.TryRemove(m.Id, out var waiting))
            {
                waiting.TrySetResult(m);
            }
        });
    }

    public void Start()
    {
        if (_server is not null || !options.Enabled)
        {
            return;
        }
        _server = new LoopbackHttp(options.Port, HandleAsync);
        _server.Start();
    }

    /// <summary>A request: the token first, then /ready (whether the page said so) or /eval (code run in the page).</summary>
    internal async Task<LoopbackResponse> HandleAsync(LoopbackRequest request)
    {
        if (!Authorized(request.Headers.GetValueOrDefault(TokenHeader.ToLowerInvariant())))
        {
            return LoopbackResponse.Status(HttpStatusCode.Forbidden);
        }
        if (request.Method == GetMethod && request.Path == ReadyPath)
        {
            return LoopbackResponse.Status(_ready ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
        }
        if (request.Method != PostMethod || request.Path != EvalPath)
        {
            return LoopbackResponse.Status(HttpStatusCode.NotFound);
        }
        TestEvalRequest? evaluation;
        try
        {
            evaluation = JsonSerializer.Deserialize<TestEvalRequest>(request.Body, PageChannel.Json);
        }
        catch (JsonException)
        {
            return LoopbackResponse.Status(HttpStatusCode.BadRequest);
        }
        if (evaluation?.Code is null || evaluation.TimeoutMs <= 0)
        {
            return LoopbackResponse.Status(HttpStatusCode.BadRequest);
        }
        var result = await EvaluateAsync(evaluation).ConfigureAwait(false);
        return new LoopbackResponse(HttpStatusCode.OK, JsonSerializer.Serialize(result, PageChannel.Json));
    }

    internal bool Authorized(string? token) => options.Enabled && token == options.Token;

    internal bool Ready => _ready;

    internal async Task<FromPage.TestResult> EvaluateAsync(TestEvalRequest request)
    {
        if (!options.Enabled)
        {
            throw new InvalidOperationException("The test driver is disabled.");
        }
        var id = Guid.NewGuid().ToString();
        var waiting = new TaskCompletionSource<FromPage.TestResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _calls[id] = waiting;
        try
        {
            page.Post(new ToPage.TestEval(id, request.Code!));
            return await waiting.Task.WaitAsync(TimeSpan.FromMilliseconds(request.TimeoutMs)).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            return new FromPage.TestResult(id, Error: "The test evaluation timed out.");
        }
        finally
        {
            _calls.TryRemove(id, out _);
        }
    }

    public void Dispose()
    {
        _server?.Dispose();
        foreach (var (id, waiting) in _calls)
        {
            waiting.TrySetResult(new FromPage.TestResult(id, Error: "The test driver stopped."));
        }
        _calls.Clear();
    }

    internal sealed record TestEvalRequest(string? Code = null, int TimeoutMs = DefaultTimeoutMs);
}

internal sealed record TestDriverOptions(int Port = 0, string? Token = null)
{
    private const string PortVariable = "TERMILLY_TEST_DRIVER";
    private const string TokenVariable = "TERMILLY_TEST_TOKEN";
    private const int MaxPort = 65535;
    public bool Enabled => Port is > 0 and <= MaxPort && !string.IsNullOrWhiteSpace(Token);

    public static TestDriverOptions FromEnvironment() => new(
        int.TryParse(Environment.GetEnvironmentVariable(PortVariable), out var port) ? port : 0,
        Environment.GetEnvironmentVariable(TokenVariable));
}
