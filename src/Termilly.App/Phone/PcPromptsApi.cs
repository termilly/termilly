using System.Net;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Prompt history for another Termilly computer (Features/RemotePcs.cs is the other side): a terminal of this PC that
/// it shows asks for what the user asked Claude Code in it, the same list this PC's own Prompt history has (its record
/// and the sessions' transcripts here). Only while Settings › Remote › Prompt history allows it.
/// </summary>
internal static class PcPrompts
{
    public const string Path = "/api/prompts";

    /// <summary>The fields of the request and its answer.</summary>
    public static class Fields
    {
        public const string Pane = "pane";
        public const string Prompts = "prompts";
        public const string Text = "text";
        public const string At = "at";
        public const string Sessions = "sessions";
        public const string Found = "found";
        public const string Steps = "steps";
        public const string Kind = "kind";
        public const string Tool = "tool";
        public const string Failed = "failed";
    }
}

/// <summary>This computer's side of <see cref="PcPrompts"/> (the device is paired: PhoneServer checked).</summary>
internal sealed class PcPromptsApi(PromptsHandler prompts, PageApi api, ISettingsStore settings)
{
    private const string Refused = "Prompt history is off on that computer: Settings › Remote › Prompt history.";
    private const string Gone = "That terminal is gone.";

    public async Task<PhoneReply> AnswerAsync(PhoneRequest request)
    {
        if (!settings.Current.Phone.SharePrompts)
        {
            return PcFilesApi.Error(Refused);
        }
        string? pane;
        try
        {
            pane = (JsonNode.Parse(request.Body) as JsonObject)?[PcPrompts.Fields.Pane]?.GetValue<string>();
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException)
        {
            pane = null;
        }
        if (string.IsNullOrEmpty(pane))
        {
            return new(HttpStatusCode.BadRequest, MediaTypes.PlainText, []);
        }
        JsonNode? found;
        try
        {
            // The page knows the terminal's Claude Code sessions (js/myprompts.js).
            found = await api.AskPageAsync(ToPage.Calls.PcSessions, new JsonObject { [PageApi.CallFields.Args] = new JsonObject { [PcPrompts.Fields.Pane] = pane } }).ConfigureAwait(false);
        }
        catch (InvalidOperationException e)
        {
            return PcFilesApi.Error(e.Message);
        }
        if (found?[PcPrompts.Fields.Found]?.GetValue<bool>() != true)
        {
            return PcFilesApi.Error(Gone);
        }
        var sessions = (found[PcPrompts.Fields.Sessions] as JsonArray)?.Select(s => s?.GetValue<string>()).OfType<string>().ToList() ?? [];
        var list = new JsonArray(prompts.Prompts(pane, sessions)
            .Select(p => (JsonNode)new JsonObject { [PcPrompts.Fields.Text] = p.Text, [PcPrompts.Fields.At] = p.At }).ToArray());
        var steps = new JsonArray(PromptsHandler.Steps(sessions).Select(s => (JsonNode)new JsonObject
        {
            [PcPrompts.Fields.Kind] = s.Kind,
            [PcPrompts.Fields.Text] = s.Text,
            [PcPrompts.Fields.At] = s.At,
            [PcPrompts.Fields.Tool] = s.Tool,
            [PcPrompts.Fields.Failed] = s.Failed,
        }).ToArray());
        return PcFilesApi.Json(new JsonObject { [PcPrompts.Fields.Prompts] = list, [PcPrompts.Fields.Steps] = steps }.ToJsonString());
    }

    /// <summary>The prompts in another computer's answer.</summary>
    public static IReadOnlyList<AgentPrompt> Read(JsonObject answer) =>
        (answer[PcPrompts.Fields.Prompts] as JsonArray)?.OfType<JsonObject>()
            .Select(p => new AgentPrompt(p[PcPrompts.Fields.Text]?.GetValue<string>() ?? "", p[PcPrompts.Fields.At]?.GetValue<string>() ?? ""))
            .Where(p => p.Text.Length > 0).ToList() ?? [];

    /// <summary>What Claude did, in another computer's answer (none from a Termilly older than 1.7.0, which sends none).</summary>
    public static IReadOnlyList<AgentStep> ReadSteps(JsonObject answer) =>
        (answer[PcPrompts.Fields.Steps] as JsonArray)?.OfType<JsonObject>()
            .Select(s => new AgentStep(
                Str(s, PcPrompts.Fields.Kind) ?? "", Str(s, PcPrompts.Fields.Text) ?? "", Str(s, PcPrompts.Fields.At) ?? "",
                Str(s, PcPrompts.Fields.Tool), s[PcPrompts.Fields.Failed] is JsonValue f && f.TryGetValue<bool>(out var failed) && failed))
            .Where(s => AgentStepKind.All.Contains(s.Kind) && s.At.Length > 0).ToList() ?? [];

    private static string? Str(JsonObject o, string name) => o[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : null;
}
