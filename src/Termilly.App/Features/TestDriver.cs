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
    private const string JsonContent = "application/json";
    private const int DefaultTimeoutMs = 30000;
    private readonly HttpListener _listener = new();
    private readonly ConcurrentDictionary<string, TaskCompletionSource<FromPage.TestResult>> _calls = new();
    private volatile bool _ready;
    private bool _started;

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
        if (_started || !options.Enabled)
        {
            return;
        }
        _started = true;
        _listener.Prefixes.Add($"http://127.0.0.1:{options.Port}/");
        _listener.Start();
        _ = ListenAsync();
    }

    private async Task ListenAsync()
    {
        try
        {
            while (_listener.IsListening)
            {
                var context = await _listener.GetContextAsync().ConfigureAwait(false);
                _ = RespondAsync(context);
            }
        }
        catch (Exception e) when (e is HttpListenerException or ObjectDisposedException)
        {
            // Closing the instance ends the pending accept.
        }
    }

    private async Task RespondAsync(HttpListenerContext context)
    {
        try
        {
            await HandleAsync(context).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpListenerException or System.IO.IOException or ObjectDisposedException)
        {
            // A test may time out and disconnect before its page answers.
        }
        finally
        {
            context.Response.Close();
        }
    }

    private async Task HandleAsync(HttpListenerContext context)
    {
        var request = context.Request;
        var response = context.Response;
        if (!Authorized(request.Headers[TokenHeader]))
        {
            response.StatusCode = (int)HttpStatusCode.Forbidden;
            return;
        }
        if (request.HttpMethod == GetMethod && request.Url?.AbsolutePath == ReadyPath)
        {
            response.StatusCode = (int)(_ready ? HttpStatusCode.OK : HttpStatusCode.ServiceUnavailable);
            return;
        }
        if (request.HttpMethod != PostMethod || request.Url?.AbsolutePath != EvalPath)
        {
            response.StatusCode = (int)HttpStatusCode.NotFound;
            return;
        }
        TestEvalRequest? evaluation;
        try
        {
            evaluation = await JsonSerializer.DeserializeAsync<TestEvalRequest>(request.InputStream, PageChannel.Json).ConfigureAwait(false);
        }
        catch (JsonException)
        {
            response.StatusCode = (int)HttpStatusCode.BadRequest;
            return;
        }
        if (evaluation?.Code is null || evaluation.TimeoutMs <= 0)
        {
            response.StatusCode = (int)HttpStatusCode.BadRequest;
            return;
        }
        var result = await EvaluateAsync(evaluation).ConfigureAwait(false);
        response.ContentType = JsonContent;
        await JsonSerializer.SerializeAsync(response.OutputStream, result, PageChannel.Json).ConfigureAwait(false);
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
        _listener.Close();
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
