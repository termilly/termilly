using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Agent;

/// <summary>
/// notify_user: the agent asks the user in the notification center (and on their phone) and waits for the answer. A
/// question may wait for hours, so it's answered on a thread of its own while the server takes the agent's other calls,
/// and when the agent stops waiting (it cancels the call, or quits) its card closes.
/// </summary>
internal static partial class Mcp
{
    /// <summary>MCP's notice that the client no longer waits for a request, and its field naming which.</summary>
    private const string CancelledNotification = "notifications/cancelled";
    private const string RequestIdKey = "requestId";
    /// <summary>MCP's progress notice, the request's token for it, and how far along it is.</summary>
    private const string ProgressNotification = "notifications/progress";
    private const string MetaKey = "_meta";
    private const string ProgressTokenKey = "progressToken";
    private const string ProgressKey = "progress";
    /// <summary>How often a waiting question says it's still waiting (well inside Claude Code's 30 quiet minutes).</summary>
    private static readonly TimeSpan HeartbeatEvery = TimeSpan.FromMinutes(1);

    /// <summary>JSON Schema's words this tool's arguments need beyond the others' (lists, closed sets).</summary>
    private static class Schema
    {
        public const string Array = "array";
        public const string Items = "items";
        public const string Enum = "enum";
    }

    private const string NotifyDescription =
        "Asks the user in Termilly's notification center (and on their phone) and waits for the answer. Use it instead of ending your turn when you need the user's decision to go on, and carry on with the answer. " +
        "ui = options: a question with 1 to 9 choices; mark the one you'd pick as recommended. Returns {answer, note?}. " +
        "ui = approve: before something the user should OK (deploying, deleting, spending), with what it does in details. Returns {approved, note?}. " +
        "ui = ask: a question answered in words, with optional suggestions. Returns {answer}. " +
        "ui = info: a one-line update that needs no answer, with at most one button opening a web address. Returns {delivered} at once. " +
        "A question can wait for hours. {skipped} means the user put it away without answering; {unavailable} means ask in your terminal instead. " +
        "Keep the title to one short line and put the rest in details.";

    private static JsonObject NotifyTool()
    {
        static JsonObject Field(string type, string description) => new() { [Keys.Type] = type, [Keys.Description] = description };
        // An object of its own fields, some of them needed.
        static JsonObject Shape(string description, JsonObject properties, params string[] required)
        {
            var shape = Field(Types.Object, description);
            shape[Keys.Properties] = properties;
            shape[Keys.Required] = new JsonArray(required.Select(r => (JsonNode)r).ToArray());
            return shape;
        }
        static JsonObject List(string description, JsonObject items)
        {
            var list = Field(Schema.Array, description);
            list[Schema.Items] = items;
            return list;
        }
        var ui = Field(Types.String, string.Join(", ", QuestionKinds.All));
        ui[Schema.Enum] = new JsonArray(QuestionKinds.All.Select(k => (JsonNode)k).ToArray());
        var choice = Shape("One choice", new JsonObject
        {
            [QuestionFields.Label] = Field(Types.String, $"What its button says, up to {QuestionLimits.MaxLabel} characters"),
            [QuestionFields.Recommended] = Field(Types.Boolean, "The one you'd pick (at most one)"),
        }, QuestionFields.Label);
        var button = Shape("For info: its one button", new JsonObject
        {
            [QuestionFields.Label] = Field(Types.String, $"Up to {QuestionLimits.MaxButtonLabel} characters"),
            [QuestionFields.Url] = Field(Types.String, "The http or https address it opens"),
        }, QuestionFields.Label, QuestionFields.Url);
        return Tool(ToolNames.NotifyUser, NotifyDescription, new JsonObject
        {
            [QuestionFields.Ui] = ui,
            [QuestionFields.Title] = Field(Types.String, $"The question or update, one line up to {QuestionLimits.MaxTitle} characters"),
            [QuestionFields.Details] = Field(Types.String, "What the user needs to decide well, shown a click away"),
            [QuestionFields.Choices] = List($"For options: 1 to {QuestionLimits.MaxChoices}. The card shows {QuestionLimits.ShownChoices}, the rest under More", choice),
            [QuestionFields.Suggestions] = List($"For ask: up to {QuestionLimits.MaxSuggestions} answers to pick from, shown above the text field", Field(Types.String, "One suggested answer")),
            [QuestionFields.Button] = button,
        }, [QuestionFields.Ui, QuestionFields.Title]);
    }

    /// <summary>
    /// Asks the user and returns their answer as the tool's result. When Termilly can't be reached, that's a result too
    /// (unavailable), so the agent asks in its terminal; a question Termilly refuses is an error the agent can fix.
    /// </summary>
    private static JsonObject Notify(JsonNode id, JsonObject? parameters, Func<string, JsonObject?, JsonNode?> call, string questionId)
    {
        var arguments = parameters?[Keys.Arguments]?.DeepClone() as JsonObject ?? [];
        arguments.Remove(ApiFields.From);
        arguments[QuestionFields.Id] = questionId; // the server's own, so it can close the card when the agent stops waiting
        try
        {
            return Result(id, ToolResult(Api.Pretty(call(ApiMethods.Notify, arguments)), isError: false));
        }
        catch (ApiUnreachableException e)
        {
            return Result(id, ToolResult(Api.Pretty(QuestionReplies.Unavailable(e.Message)), isError: false));
        }
        catch (ApiException e)
        {
            return Result(id, ToolResult(e.Message, isError: true));
        }
    }

    private static bool IsNotify(JsonObject request) =>
        request[Rpc.Method]?.ToString() == Methods.ToolsCall && (request[Rpc.Params] as JsonObject)?[Keys.Name]?.ToString() == ToolNames.NotifyUser;

    public static int Run(TextReader input, TextWriter output) =>
        Run(input, output, (method, args) => Api.Call(method, args), Environment.GetEnvironmentVariable(TerminalEnvironment.Run));

    /// <summary>The server's loop, with <paramref name="call"/> reaching Termilly's API (tests give their own).</summary>
    internal static int Run(TextReader input, TextWriter output, Func<string, JsonObject?, JsonNode?> call, string? run)
    {
        var questions = new WaitingQuestions(output, call);
        while (input.ReadLine() is { } line)
        {
            if (string.IsNullOrWhiteSpace(line))
            {
                continue;
            }
            JsonObject? request;
            try
            {
                request = JsonNode.Parse(line) as JsonObject;
            }
            catch (JsonException)
            {
                questions.Write(Error(null, Rpc.ParseError, "Parse error"));
                continue;
            }
            if (request is null || run is null && questions.Take(request))
            {
                continue;
            }
            if (Handle(request, questions.Call, run) is { } response)
            {
                questions.Write(response);
            }
        }
        questions.CancelAll(); // the agent quit: nobody hears an answer now
        return 0;
    }

    /// <summary>The questions this server waits on, by the agent's request id, and the one writer they share.</summary>
    private sealed class WaitingQuestions(TextWriter output, Func<string, JsonObject?, JsonNode?> call)
    {
        private readonly ConcurrentDictionary<string, string> _waiting = new();
        private readonly Lock _writing = new();

        public Func<string, JsonObject?, JsonNode?> Call => call;

        /// <summary>Takes a question (answered on a thread of its own) or a cancelled one; false for anything else.</summary>
        public bool Take(JsonObject request)
        {
            if (request[Rpc.Method]?.ToString() == CancelledNotification)
            {
                if ((request[Rpc.Params] as JsonObject)?[RequestIdKey] is { } cancelled && _waiting.TryRemove(cancelled.ToJsonString(), out var question))
                {
                    Cancel(question);
                }
                return true;
            }
            if (!IsNotify(request) || request[Rpc.Id]?.DeepClone() is not { } id)
            {
                return false;
            }
            var key = id.ToJsonString();
            var questionId = Guid.NewGuid().ToString("N");
            _waiting[key] = questionId;
            var beat = Heartbeat(((request[Rpc.Params] as JsonObject)?[MetaKey] as JsonObject)?[ProgressTokenKey]?.DeepClone(), key);
            _ = Task.Run(() =>
            {
                // Cancelled before it was even asked: nothing to ask, nobody to answer.
                if (!_waiting.ContainsKey(key))
                {
                    beat?.Dispose();
                    return;
                }
                var response = Notify(id, request[Rpc.Params] as JsonObject, call, questionId);
                beat?.Dispose();
                // One the agent cancelled gets no answer (MCP: the client has stopped listening for it).
                if (_waiting.TryRemove(key, out _))
                {
                    Write(response);
                }
            });
            return true;
        }

        /// <summary>
        /// While a question waits, a progress notice now and then, when the client gave a token for them: Claude Code
        /// gives up on a stdio tool that's quiet for half an hour, and a question may wait far longer.
        /// </summary>
        private Timer? Heartbeat(JsonNode? token, string key)
        {
            if (token is null)
            {
                return null;
            }
            var beats = 0;
            return new Timer(_ =>
            {
                if (_waiting.ContainsKey(key))
                {
                    Write(new JsonObject
                    {
                        [Rpc.JsonRpc] = Rpc.Version,
                        [Rpc.Method] = ProgressNotification,
                        [Rpc.Params] = new JsonObject { [ProgressTokenKey] = token.DeepClone(), [ProgressKey] = ++beats },
                    });
                }
            }, null, HeartbeatEvery, HeartbeatEvery);
        }

        public void CancelAll()
        {
            foreach (var key in _waiting.Keys)
            {
                if (_waiting.TryRemove(key, out var question))
                {
                    Cancel(question);
                }
            }
        }

        private void Cancel(string question)
        {
            try
            {
                call(ApiMethods.NotifyCancel, new JsonObject { [QuestionFields.Id] = question });
            }
            catch (ApiException)
            {
                // Termilly is gone, and the card with it.
            }
        }

        public void Write(JsonObject message)
        {
            lock (_writing)
            {
                output.WriteLine(message.ToJsonString());
                output.Flush();
            }
        }
    }
}
