extern alias agent;

using System.Collections.Concurrent;
using System.IO;
using System.Text.Json.Nodes;
using agent::Termilly.Agent;
using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>Agents' questions in the notification center: what's checked, and how notify_user waits and closes.</summary>
public sealed class QuestionsTests
{
    private static JsonObject Ask(string json) => (JsonObject)JsonNode.Parse(json)!;

    // ---- What a question may be (AgentQuestions.Check) ----

    [Fact]
    public void An_options_question_keeps_its_choices_and_drops_what_it_does_not_know()
    {
        var (question, error) = AgentQuestions.Check(Ask("""
            { "ui": "options", "title": "  Which store?  ", "choices": [{ "label": "Postgres", "recommended": true }, "Redis"], "suggestions": ["x"], "from": "t1", "evil": 1 }
            """));
        Assert.Null(error);
        Assert.Equal("Which store?", question!["title"]!.GetValue<string>());
        var choices = question["choices"]!.AsArray();
        Assert.Equal(["Postgres", "Redis"], choices.Select(c => c!["label"]!.GetValue<string>()));
        Assert.True(choices[0]!["recommended"]!.GetValue<bool>());
        Assert.False(choices[1]!["recommended"]!.GetValue<bool>());
        // Only what the kind needs: no suggestions on options, nothing unknown, and the asking terminal is the host's to add.
        Assert.Null(question["suggestions"]);
        Assert.Null(question["evil"]);
        Assert.Null(question["from"]);
        Assert.False(string.IsNullOrEmpty(question["id"]!.GetValue<string>()));
    }

    [Theory]
    [InlineData("""{ "ui": "poll", "title": "Hm" }""", "ui must be")]
    [InlineData("""{ "ui": "ask" }""", "title")]
    [InlineData("""{ "ui": "ask", "title": "two\nlines" }""", "title")]
    [InlineData("""{ "ui": "options", "title": "Pick", "choices": [] }""", "choices")]
    [InlineData("""{ "ui": "options", "title": "Pick", "choices": ["1","2","3","4","5","6","7","8","9","10"] }""", "choices")]
    [InlineData("""{ "ui": "options", "title": "Pick", "choices": [{ "label": "a", "recommended": true }, { "label": "b", "recommended": true }] }""", "recommended")]
    [InlineData("""{ "ui": "options", "title": "Pick", "choices": [{ "label": "" }] }""", "label")]
    [InlineData("""{ "ui": "info", "title": "Done", "button": { "label": "Open", "url": "file:///etc/passwd" } }""", "http")]
    [InlineData("""{ "ui": "info", "title": "Done", "button": { "url": "https://example.com" } }""", "label")]
    [InlineData("""{ "ui": "ask", "title": "Name?", "suggestions": ["a","b","c","d","e","f","g"] }""", "suggestions")]
    public void A_question_that_does_not_fit_is_refused_with_what_to_fix(string json, string says)
    {
        var (question, error) = AgentQuestions.Check(Ask(json));
        Assert.Null(question);
        Assert.Contains(says, error);
    }

    [Fact]
    public void An_update_keeps_its_web_button_and_an_ask_its_suggestions()
    {
        var info = AgentQuestions.Check(Ask("""{ "ui": "info", "title": "Deployed", "button": { "label": "Open", "url": "https://example.com/x" } }""")).Question!;
        Assert.Equal("https://example.com/x", info["button"]!["url"]!.GetValue<string>());
        var ask = AgentQuestions.Check(Ask("""{ "ui": "ask", "title": "Name?", "suggestions": [" Ada ", "", 5] }""")).Question!;
        Assert.Equal(["Ada"], ask["suggestions"]!.AsArray().Select(s => s!.GetValue<string>()));
    }

    // ---- notify_user (Mcp.Notify.cs) ----

    private static JsonObject Call(string tool, JsonObject args, int id = 1) => new()
    {
        ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = "tools/call", ["params"] = new JsonObject { ["name"] = tool, ["arguments"] = args },
    };

    private static string TextOf(JsonObject response) => response["result"]!["content"]![0]!["text"]!.GetValue<string>();

    [Fact]
    public void Notify_user_asks_with_an_id_of_the_servers_own_and_returns_the_answer()
    {
        JsonObject? sent = null;
        var response = Mcp.Handle(Call("notify_user", new JsonObject { ["ui"] = "approve", ["title"] = "Deploy?", ["from"] = "t9", ["id"] = "mine" }), (method, args) =>
        {
            Assert.Equal("notify", method);
            sent = args;
            return new JsonObject { ["approved"] = true };
        })!;
        Assert.Null(sent!["from"]);
        Assert.NotEqual("mine", sent["id"]!.GetValue<string>());
        Assert.False(response["result"]!["isError"]!.GetValue<bool>());
        Assert.True(JsonNode.Parse(TextOf(response))!["approved"]!.GetValue<bool>());
    }

    [Fact]
    public void Notify_user_says_ask_in_the_terminal_when_Termilly_is_not_there_and_errors_on_a_refusal()
    {
        var away = Mcp.Handle(Call("notify_user", new JsonObject { ["ui"] = "ask", ["title"] = "Name?" }), (_, _) => throw new ApiUnreachableException("Termilly isn't running."))!;
        Assert.False(away["result"]!["isError"]!.GetValue<bool>());
        Assert.True(JsonNode.Parse(TextOf(away))!["unavailable"]!.GetValue<bool>());

        var refused = Mcp.Handle(Call("notify_user", new JsonObject { ["ui"] = "poll", ["title"] = "x" }), (_, _) => throw new ApiException("ui must be one of options, approve, ask, info."))!;
        Assert.True(refused["result"]!["isError"]!.GetValue<bool>());
        Assert.Contains("ui must be", TextOf(refused));
    }

    [Fact]
    public void Notify_user_is_listed_with_its_four_kinds()
    {
        var tools = Mcp.Handle(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "tools/list" }, (_, _) => null)!["result"]!["tools"]!.AsArray();
        var notify = tools.Single(t => t!["name"]!.GetValue<string>() == "notify_user")!;
        Assert.Equal(["options", "approve", "ask", "info"], notify["inputSchema"]!["properties"]!["ui"]!["enum"]!.AsArray().Select(k => k!.GetValue<string>()));
    }

    /// <summary>A Termilly whose questions wait until they're cancelled, and that answers everything else at once.</summary>
    private sealed class WaitingTermilly : IDisposable
    {
        public ConcurrentQueue<(string Method, string? Id)> Calls { get; } = new();
        private readonly ManualResetEventSlim _cancelled = new();

        public JsonObject Call(string method, JsonObject? args)
        {
            Calls.Enqueue((method, args?["id"]?.GetValue<string>()));
            if (method == "notify")
            {
                _cancelled.Wait(TimeSpan.FromSeconds(10));
                return new JsonObject { ["closed"] = true };
            }
            if (method == "notify_cancel")
            {
                _cancelled.Set();
            }
            return new JsonObject();
        }

        public void Dispose() => _cancelled.Dispose();
    }

    private static string Lines(params JsonObject[] messages) => string.Join("\n", messages.Select(m => m.ToJsonString())) + "\n";

    /// <summary>
    /// The agent's lines, one at a time, holding back the one at <paramref name="waitBefore"/> until
    /// <paramref name="ready"/>: a cancel sent at once can beat the question's own thread to Termilly.
    /// </summary>
    private sealed class PacedReader(JsonObject[] messages, int waitBefore, Func<bool> ready) : TextReader
    {
        private static readonly TimeSpan MaxWait = TimeSpan.FromSeconds(10);
        private int _next;

        public override string? ReadLine()
        {
            if (_next >= messages.Length)
            {
                return null;
            }
            if (_next == waitBefore)
            {
                SpinWait.SpinUntil(ready, MaxWait);
            }
            return messages[_next++].ToJsonString();
        }
    }

    [Fact]
    public void While_a_question_waits_the_server_answers_other_calls_and_a_cancelled_one_closes_its_card()
    {
        using var termilly = new WaitingTermilly();
        JsonObject[] messages =
        [
            Call("notify_user", new JsonObject { ["ui"] = "ask", ["title"] = "Name?" }, id: 7),
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 8, ["method"] = "tools/list" },
            new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "notifications/cancelled", ["params"] = new JsonObject { ["requestId"] = 7 } },
        ];
        using var output = new StringWriter();
        // The cancel comes while the question waits in Termilly, as when the user presses Esc.
        using var input = new PacedReader(messages, waitBefore: 2, () => termilly.Calls.Any(c => c.Method == "notify"));
        Mcp.Run(input, output, termilly.Call, run: null);

        var replies = output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => JsonNode.Parse(l)!).ToList();
        Assert.Contains(replies, r => r["id"]!.GetValue<int>() == 8);
        // A cancelled request gets no answer: the agent stopped listening for it.
        Assert.DoesNotContain(replies, r => r["id"]!.GetValue<int>() == 7);
        var asked = termilly.Calls.Single(c => c.Method == "notify").Id;
        Assert.Equal(asked, termilly.Calls.Single(c => c.Method == "notify_cancel").Id);
    }

    [Fact]
    public void Odd_parameters_do_not_stop_the_server()
    {
        using var termilly = new WaitingTermilly();
        var input = Lines(
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 1, ["method"] = "tools/call", ["params"] = 5 },
            new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "notifications/cancelled", ["params"] = new JsonArray() },
            new JsonObject { ["jsonrpc"] = "2.0", ["id"] = 2, ["method"] = "tools/list" });
        using var output = new StringWriter();
        Mcp.Run(new StringReader(input), output, termilly.Call, run: null);
        Assert.Contains(output.ToString().Split('\n', StringSplitOptions.RemoveEmptyEntries), l => JsonNode.Parse(l)!["id"]!.GetValue<int>() == 2);
    }

    [Fact]
    public void An_agent_that_quits_closes_the_questions_it_waited_on()
    {
        using var termilly = new WaitingTermilly();
        using var output = new StringWriter();
        Mcp.Run(new StringReader(Lines(Call("notify_user", new JsonObject { ["ui"] = "approve", ["title"] = "Go?" }, id: 3))), output, termilly.Call, run: null);
        Assert.Contains(termilly.Calls, c => c.Method == "notify_cancel");
        Assert.Equal("", output.ToString().Trim());
    }
}
