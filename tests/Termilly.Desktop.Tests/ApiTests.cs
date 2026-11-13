extern alias agent;

using System.Text.Json.Nodes;
using agent::Termilly.Agent;

namespace Termilly.Desktop.Tests;

public sealed class ApiTests
{
    // ---- Requests on the pipe ----

    [Fact]
    public void Api_requests_are_told_apart_from_hook_events()
    {
        Assert.NotNull(AgentHooks.ApiRequest("""{"v":1,"api":"list"}"""));
        Assert.Null(AgentHooks.ApiRequest("""{"v":1,"pane":"p","event":"Stop"}"""));
        Assert.Null(AgentHooks.ApiRequest("""{"v":2,"api":"list"}"""));
        Assert.Null(AgentHooks.ApiRequest("nope"));
    }

    [Fact]
    public async Task Api_requests_get_the_handlers_answer_over_the_pipe()
    {
        using var hooks = new AgentHooks(_ => false, $"termilly-test-{Guid.NewGuid():N}",
            request => Task.FromResult(new JsonObject { ["ok"] = true, ["result"] = $"called {request["api"]}" }));

        var result = await Task.Run(() => Api.Call("list", pipe: hooks.PipeName));

        Assert.Equal("called list", result!.GetValue<string>());
    }

    [Fact]
    public void A_refusal_comes_back_as_its_message() =>
        Assert.Equal("nope", Assert.Throws<ApiException>(() =>
        {
            using var hooks = new AgentHooks(_ => false, $"termilly-test-{Guid.NewGuid():N}",
                _ => Task.FromResult(new JsonObject { ["ok"] = false, ["error"] = "nope" }));
            Api.Call("send", pipe: hooks.PipeName);
        }).Message);

    // ---- The termilly command ----

    [Fact]
    public void Open_takes_options_and_everything_after_two_dashes_as_the_command()
    {
        var args = Cli.OpenArguments(["--profile", "Git Bash", "--name", "dev", "--", "npm", "run", "dev"]);
        Assert.Equal("Git Bash", args["profile"]!.GetValue<string>());
        Assert.Equal("dev", args["name"]!.GetValue<string>());
        Assert.Equal("npm run dev", args["command"]!.GetValue<string>());
        Assert.Null(args["cwd"]);
    }

    [Fact]
    public void Open_keeps_each_word_after_two_dashes_whole_so_the_app_can_quote_it()
    {
        // A prompt with spaces and brackets is one word here; joined into "command" it would reach the shell as code.
        var args = Cli.OpenArguments(["--name", "Claude 1", "--", "claude", "Spawn 3 agents (in a single message)"]);
        var argv = args["argv"]!.AsArray().Select(w => w!.GetValue<string>()).ToArray();
        Assert.Equal(["claude", "Spawn 3 agents (in a single message)"], argv);
    }

    // ---- History search ----

    [Fact]
    public void History_search_filters_and_always_redacts()
    {
        var history = """
            [ {"command":"npm test","exitCode":1,"cwd":"C:\\dev\\api"},
              {"command":"mysql -u root -pS3cretPass","exitCode":0,"cwd":"C:\\dev\\db"},
              {"command":"npm run build","exitCode":0,"cwd":"C:\\dev\\api"} ]
            """;

        var failed = ApiHistory.Search(history, new JsonObject { ["failed"] = true });
        Assert.Equal(["npm test"], failed.Select(e => e!["command"]!.GetValue<string>()));

        var inApi = ApiHistory.Search(history, new JsonObject { ["in"] = "api", ["query"] = "NPM" });
        Assert.Equal(2, inApi.Count);

        var all = ApiHistory.Search(history, new JsonObject { ["limit"] = 10 });
        Assert.DoesNotContain("S3cretPass", all.ToJsonString());
    }

    // ---- MCP ----

    private static JsonNode? FakeTermilly(string method, JsonObject? args, bool allowInput = false) => method switch
    {
        "capabilities" => new JsonObject { ["allowInput"] = allowInput },
        "list" => new JsonArray(new JsonObject { ["id"] = "t1", ["title"] = "PowerShell" }),
        "send" => throw new ApiException("Typing is off."),
        _ => new JsonObject { ["method"] = method, ["args"] = args?.DeepClone() },
    };

    private static JsonObject Request(string method, JsonObject? parameters = null, int id = 1) =>
        new() { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters };

    [Fact]
    public void Mcp_initializes_and_lists_every_tool_whether_typing_is_allowed_or_not()
    {
        var init = Mcp.Handle(Request("initialize", new JsonObject { ["protocolVersion"] = "2025-03-26" }), (m, a) => FakeTermilly(m, a))!;
        Assert.Equal("2025-03-26", init["result"]!["protocolVersion"]!.GetValue<string>());
        // The instructions say how to work with other terminals, not only what the tools are.
        Assert.Contains("ask_terminal", init["result"]!["instructions"]!.GetValue<string>());

        var tools = Mcp.Handle(Request("tools/list"), (m, a) => FakeTermilly(m, a))!["result"]!["tools"]!.AsArray();
        var names = tools.Select(t => t!["name"]!.GetValue<string>()).ToList();
        Assert.Equal(["list_terminals", "terminal_state", "search_command_history", "set_status", "read_terminal_output", "wait_for_terminal", "list_tasks", "get_task", "tick_task", "finish_task", "add_task", "list_schedules", "add_schedule", "run_schedule", "set_schedule", "list_notepad_pages", "read_notepad_page", "add_notepad_page", "write_notepad_page", "rename_notepad_page", "ask_terminal", "run_snippet", "open_terminal", "send_to_terminal", "list_snippets", "ask_agent"], names);
        // Listed with typing off too, so an agent knows they're there; each says what it needs.
        var withInput = Mcp.Handle(Request("tools/list"), (m, a) => FakeTermilly(m, a, allowInput: true))!["result"]!["tools"]!.AsArray();
        Assert.Equal(names, withInput.Select(t => t!["name"]!.GetValue<string>()));
        Assert.All(["ask_terminal", "run_snippet", "send_to_terminal", "add_schedule", "run_schedule", "set_schedule", "open_terminal"],
            name => Assert.Contains("Let scripts and agents type", tools.Single(t => t!["name"]!.GetValue<string>() == name)!["description"]!.GetValue<string>()));
    }

    [Theory]
    [InlineData("""{ "method": "open", "command": "npm test" }""", true)]
    [InlineData("""{ "method": "open", "argv": ["npm", "test"] }""", true)]
    [InlineData("""{ "method": "open", "command": 5 }""", true)]
    [InlineData("""{ "method": "open", "argv": "npm" }""", true)]
    [InlineData("""{ "method": "open", "cwd": "C:\\src" }""", false)]
    [InlineData("""{ "method": "open", "command": "  ", "argv": [] }""", false)]
    [InlineData("""{ "method": "open", "command": null }""", false)]
    public void Opening_a_terminal_runs_a_command_when_it_names_one(string request, bool runs) =>
        Assert.Equal(runs, Features.PageApi.RunsCommand(JsonNode.Parse(request)!.AsObject()));

    [Fact]
    public void Mcp_tool_calls_return_text_and_failures_as_tool_errors()
    {
        var list = Mcp.Handle(Request("tools/call", new JsonObject { ["name"] = "list_terminals" }), (m, a) => FakeTermilly(m, a))!["result"]!;
        Assert.False(list["isError"]!.GetValue<bool>());
        Assert.Contains("PowerShell", list["content"]![0]!["text"]!.GetValue<string>());

        var send = Mcp.Handle(Request("tools/call", new JsonObject { ["name"] = "send_to_terminal", ["arguments"] = new JsonObject { ["pane"] = "t1" } }), (m, a) => FakeTermilly(m, a))!["result"]!;
        Assert.True(send["isError"]!.GetValue<bool>());
        Assert.Equal("Typing is off.", send["content"]![0]!["text"]!.GetValue<string>());

        Assert.Null(Mcp.Handle(new JsonObject { ["jsonrpc"] = "2.0", ["method"] = "notifications/initialized" }, (m, a) => FakeTermilly(m, a)));
        Assert.Equal(-32601, Mcp.Handle(Request("resources/list"), (m, a) => FakeTermilly(m, a))!["error"]!["code"]!.GetValue<int>());
    }

    // ---- A run out of sight asking the user (AskingRun.cs) ----

    [Fact]
    public void A_run_out_of_sight_gets_only_ask_permission_and_it_carries_the_users_answer()
    {
        var tools = Mcp.Handle(Request("tools/list"), (m, a) => FakeTermilly(m, a), run: "r1")!["result"]!["tools"]!.AsArray();
        Assert.Equal(["ask_permission"], tools.Select(t => t!["name"]!.GetValue<string>()));

        JsonObject? asked = null;
        var call = Request("tools/call", new JsonObject
        {
            ["name"] = "ask_permission",
            ["arguments"] = new JsonObject { ["tool_name"] = "PowerShell", ["input"] = new JsonObject { ["command"] = "npm run check" }, ["tool_use_id"] = "x" },
        });
        var answer = Mcp.Handle(call, (m, a) =>
        {
            Assert.Equal("task_ask", m);
            asked = a;
            return new JsonObject { ["behavior"] = "allow", ["updatedInput"] = a!["input"]!.DeepClone() };
        }, run: "r1")!["result"]!;
        Assert.Equal("r1", asked!["run"]!.GetValue<string>());
        Assert.Equal("PowerShell", asked["tool_name"]!.GetValue<string>());
        Assert.False(answer["isError"]!.GetValue<bool>());
        var said = JsonNode.Parse(answer["content"]![0]!["text"]!.GetValue<string>())!;
        Assert.Equal("allow", said["behavior"]!.GetValue<string>());
        Assert.Equal("npm run check", said["updatedInput"]!["command"]!.GetValue<string>());

        // Termilly gone or the run over: refused, saying why, so Claude Code goes on without it.
        var refused = Mcp.Handle(call, (_, _) => throw new ApiException("That run has ended."), run: "r1")!["result"]!;
        var no = JsonNode.Parse(refused["content"]![0]!["text"]!.GetValue<string>())!;
        Assert.Equal("deny", no["behavior"]!.GetValue<string>());
        Assert.Contains("That run has ended.", no["message"]!.GetValue<string>());

        // The other tools aren't there for it.
        Assert.Equal(-32602, Mcp.Handle(Request("tools/call", new JsonObject { ["name"] = "list_tasks" }), (m, a) => FakeTermilly(m, a), run: "r1")!["error"]!["code"]!.GetValue<int>());
    }

    [Fact]
    public void A_runs_config_path_is_quoted_for_its_shell()
    {
        Assert.Equal("'C:\\Users\\o''neil\\x.json'", AskingRun.Quote("C:\\Users\\o'neil\\x.json", "powershell"));
        Assert.Equal("\"C:\\Users\\me\\x.json\"", AskingRun.Quote("C:\\Users\\me\\x.json", "cmd"));
        Assert.Equal("'/home/o'\\''neil/x.json'", AskingRun.Quote("/home/o'neil/x.json", "bash"));
    }
}
