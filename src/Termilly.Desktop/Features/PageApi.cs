using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The termilly command's and MCP server's requests (Termilly.Agent/Api.cs): command
/// history is answered here, always redacted; the rest is about terminals, which the page knows, so it's asked
/// (<see cref="AskPageAsync"/>) and its answer returned.
/// </summary>
internal sealed class PageApi(PageChannel page, ISettingsStore settings, IAppWindow window, Vault vault, CommandHistory commands) : IMessageHandler
{

    /// <summary>How long the page has to answer, unless the call says otherwise.</summary>
    private static readonly TimeSpan PageWait = TimeSpan.FromSeconds(5);
    /// <summary>Typing may wait on the user (a terminal on production asks first): a little less than the caller waits.</summary>
    private static readonly TimeSpan TypingWait = PipeTimeouts.ApiWaiting - TimeSpan.FromSeconds(5);

    /// <summary>The methods about terminals, which the page answers.</summary>
    private static readonly string[] PageMethods = [ApiMethods.List, ApiMethods.State, ApiMethods.Status, ApiMethods.Open, ApiMethods.Send, ApiMethods.Snippets, ApiMethods.Snippet, ApiMethods.Read, ApiMethods.Wait];
    /// <summary>The methods that return a terminal's output, which is redacted for an agent.</summary>
    private static readonly string[] OutputMethods = [ApiMethods.Read, ApiMethods.Wait];

    /// <summary>The page's own call's fields: the method and its arguments.</summary>
    public static class CallFields
    {
        public const string Method = "method";
        public const string Args = "args";
    }

    private readonly ConcurrentDictionary<string, TaskCompletionSource<FromPage.ApiResult>> _calls = new();
    /// <summary>Whether the page has reported in; requests to open a folder before that wait in <see cref="_early"/>.</summary>
    private volatile bool _pageReady;
    private readonly ConcurrentQueue<JsonObject> _early = new();

    public void Register(MessageRouter router) =>
        router.On<FromPage.ApiResult>(m =>
        {
            if (m.RequestId is { } requestId && _calls.TryRemove(requestId, out var waiting))
            {
                waiting.TrySetResult(m);
            }
        });

    /// <summary>The page is up: a folder Termilly was started with opens now, and those handed over while it loaded.</summary>
    public void PageReady()
    {
        _pageReady = true;
        if (window.StartFolder is { } folder)
        {
            // Started with a folder ("Open in Termilly", termilly <folder>): a terminal there, as a running Termilly would open it.
            _ = HandleAsync(new JsonObject { [ApiFields.Method] = ApiMethods.Open, [ApiFields.Cwd] = folder, [ApiFields.Reuse] = true });
        }
        while (_early.TryDequeue(out var early))
        {
            _ = HandleAsync(early);
        }
    }

    /// <summary>Answers one request on a pool thread. Typing into a terminal needs Settings › Terminal › API.</summary>
    public async Task<JsonObject> HandleAsync(JsonObject request)
    {
        static JsonObject Ok(JsonNode? result) => new() { [ApiFields.Ok] = true, [ApiFields.Result] = result };
        static JsonObject No(string error) => new() { [ApiFields.Ok] = false, [ApiFields.Error] = error };

        var method = request[ApiFields.Method]!.ToString();
        var activate = request[ApiFields.Activate]?.GetValueKind() == JsonValueKind.True;
        var current = settings.Current;
        switch (method)
        {
            case ApiMethods.Activate:
                // Termilly started again while this one runs (OpenFolder.cs): this window comes to the front.
                window.BringToFront();
                return Ok(null);
            case ApiMethods.Open when !_pageReady && activate:
                // A folder handed over while the page is still loading: opened once it's up.
                _early.Enqueue(request);
                window.BringToFront();
                return Ok(new JsonObject { [ApiFields.Queued] = true });
            case ApiMethods.Capabilities:
                return Ok(new JsonObject { [ApiFields.AllowInput] = current.Agents.ApiAllowInput });
            case ApiMethods.History:
                return vault.IsLocked ? No("History is locked.") : Ok(ApiHistory.Search(commands.List(current.Session.HistoryDays), request));
            case var typing when ApiMethods.Typing.Contains(typing) && !current.Agents.ApiAllowInput:
                return No("Typing into terminals from scripts and agents is off. Turn it on in Termilly: Settings › Terminal › Let scripts and agents type.");
            case var asked when PageMethods.Contains(asked):
                try
                {
                    var wait = ApiMethods.Typing.Contains(method) || method == ApiMethods.Wait ? TypingWait : PageWait;
                    var reply = await AskPageAsync(ToPage.Calls.Api, new JsonObject { [CallFields.Method] = method, [CallFields.Args] = request.DeepClone() }, wait).ConfigureAwait(false);
                    if (OutputMethods.Contains(method))
                    {
                        reply = TerminalOutput.ForAgent(reply);
                    }
                    if (method == ApiMethods.Open && activate)
                    {
                        window.BringToFront(); // "Open in Termilly" from the file manager (OpenFolder.cs)
                    }
                    return Ok(reply);
                }
                catch (InvalidOperationException e)
                {
                    return No(e.Message);
                }
            default:
                return No($"Unknown method {method}.");
        }
    }

    /// <summary>
    /// Asks the page and waits for its answer (api:result); throws with its error, or when it doesn't answer.
    /// <paramref name="fields"/> go into the message as they are: { type, requestId, ...fields }.
    /// </summary>
    public async Task<JsonNode?> AskPageAsync(string type, JsonObject fields, TimeSpan? wait = null)
    {
        var requestId = Guid.NewGuid().ToString("N");
        var answer = new TaskCompletionSource<FromPage.ApiResult>(TaskCreationOptions.RunContinuationsAsynchronously);
        _calls[requestId] = answer;
        page.PostJson(new ToPage.PageCall(type, requestId, fields).Json());
        var finished = await Task.WhenAny(answer.Task, Task.Delay(wait ?? PageWait)).ConfigureAwait(false);
        _calls.TryRemove(requestId, out _);
        if (finished != answer.Task)
        {
            throw new InvalidOperationException("Termilly's window didn't answer.");
        }
        var reply = answer.Task.Result;
        return reply.Error is { Length: > 0 } error
            ? throw new InvalidOperationException(error)
            : reply.Result is { } result ? JsonNode.Parse(result.GetRawText()) : null;
    }
}
