using System.Net.Http;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Tests;

public sealed class AssistantTests
{
    private const string Password = "Tr0ub4dor&3-horse";
    private const string GitHubToken = "ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789";

    [Fact]
    public void A_saved_password_and_tokens_never_go_out()
    {
        var sent = Assistant.Prepare(
            [new AiMessage("user", $"why does login fail with {Password}?")],
            output: $"PS> git push https://{GitHubToken}@github.com/x/y\nerror: denied for pass {Password}",
            outputName: "PowerShell",
            history: $"exit 1 · C:\\dev · ssh -p 22 admin@host # {Password}",
            knownSecrets: [Password]);

        var text = string.Join("\n", sent.Select(m => m.Content));
        Assert.DoesNotContain(Password, text);
        Assert.DoesNotContain(GitHubToken, text);
        Assert.Contains("[redacted]", text);
        Assert.Contains("Output of the terminal \"PowerShell\"", text);
        Assert.Contains("why does login fail", text);
    }

    [Fact]
    public void Context_goes_only_in_front_of_the_last_question()
    {
        var sent = Assistant.Prepare(
            [new AiMessage("user", "first"), new AiMessage("assistant", "answer"), new AiMessage("user", "second")],
            output: null, outputName: null, history: "exit 0 · C:\\ · ls", knownSecrets: []);

        Assert.Equal(["first", "answer"], sent.Take(2).Select(m => m.Content));
        Assert.StartsWith("Commands I ran recently", sent[2].Content);
        Assert.EndsWith("second", sent[2].Content);
    }

    [Fact]
    public void Off_builds_no_request()
    {
        var ex = Assert.Throws<InvalidOperationException>(() => Assistant.BuildRequest(new AppSettings(), "key", [new AiMessage("user", "hi")]));
        Assert.Contains("off", ex.Message);
    }

    [Fact]
    public async Task Anthropic_requests_carry_the_key_header_and_system_prompt()
    {
        using var request = Assistant.BuildRequest(new AppSettings { Ai = new() { Provider = "anthropic" } }, "sk-ant-test", [new AiMessage("user", "hi")]);

        Assert.Equal("https://api.anthropic.com/v1/messages", request.RequestUri!.ToString());
        Assert.Equal("sk-ant-test", request.Headers.GetValues("x-api-key").Single());
        Assert.Equal("2023-06-01", request.Headers.GetValues("anthropic-version").Single());
        var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Assert.Equal(Assistant.DefaultAnthropicModel, body["model"]!.GetValue<string>());
        Assert.Equal(Assistant.SystemPrompt, body["system"]!.GetValue<string>());
        Assert.Equal("hi", body["messages"]![0]!["content"]!.GetValue<string>());
        Assert.Throws<InvalidOperationException>(() => Assistant.BuildRequest(new AppSettings { Ai = new() { Provider = "anthropic" } }, null, [new AiMessage("user", "hi")]));
    }

    [Fact]
    public async Task Local_requests_go_to_the_chat_completions_endpoint()
    {
        var settings = new AppSettings { Ai = new() { Provider = "local", Endpoint = "http://127.0.0.1:1234/v1/", Model = "qwen" } }.Normalize();
        using var request = Assistant.BuildRequest(settings, null, [new AiMessage("user", "hi")]);

        Assert.Equal("http://127.0.0.1:1234/v1/chat/completions", request.RequestUri!.ToString());
        Assert.False(request.Headers.Contains("x-api-key"));
        var body = JsonNode.Parse(await request.Content!.ReadAsStringAsync())!;
        Assert.Equal("qwen", body["model"]!.GetValue<string>());
        Assert.Equal("system", body["messages"]![0]!["role"]!.GetValue<string>());
    }

    [Fact]
    public void Replies_and_errors_parse_for_both_providers()
    {
        Assert.Equal("Use git pull.", Assistant.ParseReply("anthropic", """{"content":[{"type":"text","text":"Use git "},{"type":"text","text":"pull."}]}"""));
        Assert.Equal("ls -la", Assistant.ParseReply("local", """{"choices":[{"message":{"role":"assistant","content":"ls -la"}}]}"""));
        Assert.Equal("invalid x-api-key (401)", Assistant.ErrorText(401, """{"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}"""));
        Assert.Equal("The AI service answered 502.", Assistant.ErrorText(502, "<html>"));
    }

    [Fact]
    public void Unknown_settings_fall_back_to_off_and_ask()
    {
        var s = new AppSettings { Ai = new() { Provider = "openai", ReadOutput = "sometimes", Endpoint = "file:///c:/x" } }.Normalize();
        Assert.Equal(("off", "ask", "http://localhost:11434/v1"), (s.Ai.Provider, s.Ai.ReadOutput, s.Ai.Endpoint));
    }
}
