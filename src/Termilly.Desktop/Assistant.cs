using System.Globalization;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>A turn in the assistant conversation: "user" or "assistant".</summary>
internal sealed record AiMessage(string Role, string Content)
{
    public const string User = "user";
    public const string Assistant = "assistant";
}

/// <summary>
/// The optional AI assistant (Settings › AI, off by default): questions about a terminal go to Anthropic with the
/// user's own API key, or to a local OpenAI-compatible server (Ollama, LM Studio). Nothing is sent while it's off.
/// What's sent (the conversation, and terminal output or command history only when the user allowed it) is
/// redacted first: secrets that look like secrets, and exact copies of the passwords Termilly keeps for SSH
/// connections, so a stored password never reaches the model.
/// </summary>
internal static class Assistant
{
    public const string KeyTarget = "Termilly/ai/anthropic";
    public const string DefaultAnthropicModel = "claude-sonnet-5-5";
    public const string DefaultLocalModel = "llama3.2";
    private const string AnthropicUrl = "https://api.anthropic.com/v1/messages";
    private const string AnthropicVersion = "2023-06-01";
    /// <summary>The longest answer asked of Anthropic, in tokens.</summary>
    private const int MaxTokens = 1500;
    /// <summary>How many recent commands the model is shown.</summary>
    private const int HistoryCount = 30;
    /// <summary>Known secrets shorter than this aren't replaced: they'd match ordinary text.</summary>
    private const int MinSecretLength = 4;
    private const string Redacted = "[redacted]";
    private const string JsonType = "application/json";
    /// <summary>A local OpenAI-compatible server's chat endpoint, under its base address.</summary>
    private const string ChatCompletions = "/chat/completions";

    /// <summary>The request and reply fields of both APIs.</summary>
    private static class Fields
    {
        public const string Model = "model";
        public const string MaxTokens = "max_tokens";
        public const string System = "system";
        public const string Messages = "messages";
        public const string Role = "role";
        public const string Content = "content";
        public const string Stream = "stream";
        public const string Type = "type";
        public const string Text = "text";
        public const string Choices = "choices";
        public const string Message = "message";
        public const string Error = "error";
        public const string ApiKey = "x-api-key";
        public const string Version = "anthropic-version";
    }

    /// <summary>The role of the system prompt in an OpenAI-style conversation.</summary>
    private const string SystemRole = "system";
    /// <summary>A content block of text in Anthropic's reply.</summary>
    private const string TextBlock = "text";

    public const string SystemPrompt =
        "You are the assistant inside Termilly, a terminal app for Windows. Answer briefly and concretely. When you " +
        "suggest a command, put it alone in a fenced code block tagged with the shell (powershell, bash, cmd), one command " +
        "per block. Terminal output and history you're given were redacted: [redacted] stands for a secret.";

    private static readonly HttpClient Http = new() { Timeout = TimeSpan.FromMinutes(2) };

    public static string ModelFor(AppSettings settings) =>
        settings.Ai.Model ?? (settings.Ai.Provider == SettingValues.AiProvider.Local ? DefaultLocalModel : DefaultAnthropicModel);

    /// <summary>Redacts text before it leaves the PC: likely secrets, and every known secret wherever it appears.</summary>
    public static string Scrub(string text, IEnumerable<string> knownSecrets)
    {
        foreach (var secret in knownSecrets.Where(s => s.Length >= MinSecretLength).OrderByDescending(s => s.Length))
        {
            text = text.Replace(secret, Redacted, StringComparison.Ordinal);
        }
        return SecretRedactor.Redact(text);
    }

    /// <summary>
    /// The conversation as sent: the last question carries the shared context (terminal output, history) in front
    /// of it; everything is scrubbed.
    /// </summary>
    public static List<AiMessage> Prepare(IReadOnlyList<AiMessage> conversation, string? output, string? outputName, string? history, IEnumerable<string> knownSecrets)
    {
        var secrets = knownSecrets.ToList();
        var messages = conversation.Select(m => m with { Content = Scrub(m.Content, secrets) }).ToList();
        if (messages.Count == 0 || messages[^1].Role != AiMessage.User)
        {
            throw new InvalidOperationException("The conversation must end with a question.");
        }
        var context = new StringBuilder();
        if (!string.IsNullOrWhiteSpace(output))
        {
            context.Append(CultureInfo.InvariantCulture, $"Output of the terminal \"{outputName}\" (last lines):\n```\n{Scrub(output.TrimEnd(), secrets)}\n```\n\n");
        }
        if (!string.IsNullOrWhiteSpace(history))
        {
            context.Append(CultureInfo.InvariantCulture, $"Commands I ran recently (newest last):\n```\n{Scrub(history.TrimEnd(), secrets)}\n```\n\n");
        }
        if (context.Length > 0)
        {
            messages[^1] = messages[^1] with { Content = context + messages[^1].Content };
        }
        return messages;
    }

    /// <summary>Recent commands as lines for the model: "exit 1 · C:\dev · npm test".</summary>
    public static string HistoryText(string historyJson, int count = HistoryCount)
    {
        if (JsonNode.Parse(historyJson) is not JsonArray entries)
        {
            return "";
        }
        return string.Join('\n', entries.OfType<JsonObject>().Take(count).Reverse().Select(e =>
            $"exit {e[CommandHistory.Fields.ExitCode]?.ToString() ?? "?"} · {e[CommandHistory.Fields.Cwd]?.GetValue<string>() ?? "?"} · {e[CommandHistory.Fields.Command]?.GetValue<string>()}"));
    }

    public static HttpRequestMessage BuildRequest(AppSettings settings, string? apiKey, IReadOnlyList<AiMessage> messages)
    {
        var model = ModelFor(settings);
        var chat = new JsonArray(messages.Select(m => (JsonNode)new JsonObject { [Fields.Role] = m.Role, [Fields.Content] = m.Content }).ToArray());
        if (settings.Ai.Provider == SettingValues.AiProvider.Anthropic)
        {
            var body = new JsonObject { [Fields.Model] = model, [Fields.MaxTokens] = MaxTokens, [Fields.System] = SystemPrompt, [Fields.Messages] = chat };
            var request = new HttpRequestMessage(HttpMethod.Post, AnthropicUrl) { Content = new StringContent(body.ToJsonString(), Encoding.UTF8, JsonType) };
            request.Headers.Add(Fields.ApiKey, apiKey ?? throw new InvalidOperationException("Add your Anthropic API key in Settings › AI."));
            request.Headers.Add(Fields.Version, AnthropicVersion);
            return request;
        }
        if (settings.Ai.Provider == SettingValues.AiProvider.Local)
        {
            chat.Insert(0, new JsonObject { [Fields.Role] = SystemRole, [Fields.Content] = SystemPrompt });
            var body = new JsonObject { [Fields.Model] = model, [Fields.Messages] = chat, [Fields.Stream] = false };
            return new HttpRequestMessage(HttpMethod.Post, settings.Ai.Endpoint + ChatCompletions)
            {
                Content = new StringContent(body.ToJsonString(), Encoding.UTF8, JsonType),
            };
        }
        throw new InvalidOperationException("The AI assistant is off. Turn it on in Settings › AI.");
    }

    /// <summary>The answer's text from either kind of response.</summary>
    public static string ParseReply(string provider, string json)
    {
        var root = JsonNode.Parse(json);
        if (provider == SettingValues.AiProvider.Anthropic)
        {
            return string.Concat((root?[Fields.Content] as JsonArray ?? []).OfType<JsonObject>()
                .Where(b => b[Fields.Type]?.GetValue<string>() == TextBlock).Select(b => b[Fields.Text]?.GetValue<string>()));
        }
        return root?[Fields.Choices]?[0]?[Fields.Message]?[Fields.Content]?.GetValue<string>() ?? "";
    }

    /// <summary>A short reason from an error response ("invalid x-api-key"), or the status.</summary>
    public static string ErrorText(int status, string body)
    {
        try
        {
            var root = JsonNode.Parse(body);
            var message = root?[Fields.Error]?[Fields.Message]?.GetValue<string>() ?? root?[Fields.Error]?.GetValue<string>();
            if (!string.IsNullOrWhiteSpace(message))
            {
                return $"{message} ({status})";
            }
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
        }
        return $"The AI service answered {status}.";
    }

    /// <summary>Sends the prepared conversation and returns the answer; throws with a readable message.</summary>
    public static async Task<string> AskAsync(AppSettings settings, string? apiKey, IReadOnlyList<AiMessage> messages, CancellationToken cancel)
    {
        using var request = BuildRequest(settings, apiKey, messages);
        try
        {
            using var response = await Http.SendAsync(request, cancel);
            var body = await response.Content.ReadAsStringAsync(cancel);
            if (!response.IsSuccessStatusCode)
            {
                throw new InvalidOperationException(ErrorText((int)response.StatusCode, body));
            }
            return ParseReply(settings.Ai.Provider, body);
        }
        catch (HttpRequestException e)
        {
            throw new InvalidOperationException(settings.Ai.Provider == SettingValues.AiProvider.Local
                ? $"Couldn't reach {settings.Ai.Endpoint} ({e.Message}). Is the local model server running?"
                : $"Couldn't reach Anthropic: {e.Message}");
        }
        catch (TaskCanceledException) when (!cancel.IsCancellationRequested)
        {
            throw new InvalidOperationException("The AI service took too long to answer.");
        }
    }
}
