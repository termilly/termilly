using System.Text.Json.Nodes;

namespace Termilly.Desktop.Features;

/// <summary>
/// An agent's question for the notification center (the API's notify, Shared/Questions.cs), checked before the page shows
/// it: a kind it knows, a title, and for each kind what it needs (choices, suggestions, a button). What's wrong goes back
/// to the agent in words it can fix its call with.
/// </summary>
internal static class AgentQuestions
{
    /// <summary>The checked question, or why it was refused.</summary>
    internal sealed record Checked(JsonObject? Question, string? Error);

    /// <summary>A button's link opens in the browser, so only a web address is taken.</summary>
    private static readonly string[] WebSchemes = [Uri.UriSchemeHttp, Uri.UriSchemeHttps];

    /// <summary>
    /// The question the page shows: its id, kind, title and details, and the kind's own parts, each checked and trimmed.
    /// Anything else the agent sent is left out.
    /// </summary>
    public static Checked Check(JsonObject request)
    {
        var ui = request[QuestionFields.Ui].AsText();
        if (!QuestionKinds.All.Contains(ui))
        {
            return No($"ui must be one of {string.Join(", ", QuestionKinds.All)}.");
        }
        var title = request[QuestionFields.Title].AsText()?.Trim();
        if (string.IsNullOrEmpty(title) || title.Length > QuestionLimits.MaxTitle || title.Contains('\n'))
        {
            return No($"title must be one line of 1 to {QuestionLimits.MaxTitle} characters.");
        }
        var details = request[QuestionFields.Details].AsText()?.Trim() ?? "";
        if (details.Length > QuestionLimits.MaxDetails)
        {
            return No($"details must be at most {QuestionLimits.MaxDetails} characters.");
        }
        var question = new JsonObject
        {
            [QuestionFields.Id] = request[QuestionFields.Id].AsText() is { Length: > 0 } id ? id : Guid.NewGuid().ToString("N"),
            [QuestionFields.Ui] = ui,
            [QuestionFields.Title] = title,
            [QuestionFields.Details] = details,
        };
        var error = ui switch
        {
            QuestionKinds.Options => AddChoices(request, question),
            QuestionKinds.Ask => AddSuggestions(request, question),
            QuestionKinds.Info => AddButton(request, question),
            _ => null,
        };
        return error is null ? new Checked(question, null) : No(error);
    }

    private static Checked No(string error) => new(null, error);

    /// <summary>1 to 9 choices with a label each, at most one recommended.</summary>
    private static string? AddChoices(JsonObject request, JsonObject question)
    {
        if (request[QuestionFields.Choices] is not JsonArray given || given.Count is 0 or > QuestionLimits.MaxChoices)
        {
            return $"options needs choices: 1 to {QuestionLimits.MaxChoices} of {{ label, recommended? }}.";
        }
        var choices = new JsonArray();
        foreach (var choice in given)
        {
            // A plain string is taken as its label: models often send them so.
            var label = (choice is JsonObject o ? o[QuestionFields.Label].AsText() : choice.AsText())?.Trim();
            if (string.IsNullOrEmpty(label) || label.Length > QuestionLimits.MaxLabel)
            {
                return $"Each choice needs a label of 1 to {QuestionLimits.MaxLabel} characters.";
            }
            var recommended = choice is JsonObject r && r[QuestionFields.Recommended].AsBool() == true;
            choices.Add(new JsonObject { [QuestionFields.Label] = label, [QuestionFields.Recommended] = recommended });
        }
        if (choices.Count(c => c![QuestionFields.Recommended].AsBool() == true) > 1)
        {
            return "At most one choice can be recommended.";
        }
        question[QuestionFields.Choices] = choices;
        return null;
    }

    /// <summary>Up to six suggestions, each a short line.</summary>
    private static string? AddSuggestions(JsonObject request, JsonObject question)
    {
        var given = request[QuestionFields.Suggestions] as JsonArray ?? [];
        var suggestions = given.Select(s => s.AsText()?.Trim()).Where(s => !string.IsNullOrEmpty(s)).ToList();
        if (suggestions.Count > QuestionLimits.MaxSuggestions || suggestions.Any(s => s!.Length > QuestionLimits.MaxLabel))
        {
            return $"suggestions: at most {QuestionLimits.MaxSuggestions}, each up to {QuestionLimits.MaxLabel} characters.";
        }
        question[QuestionFields.Suggestions] = new JsonArray(suggestions.Select(s => (JsonNode)s!).ToArray());
        return null;
    }

    /// <summary>An update's one button, if it has one: a label and the web address it opens.</summary>
    private static string? AddButton(JsonObject request, JsonObject question)
    {
        if (request[QuestionFields.Button] is not JsonObject button)
        {
            return null;
        }
        var label = button[QuestionFields.Label].AsText()?.Trim();
        var url = button[QuestionFields.Url].AsText()?.Trim();
        if (string.IsNullOrEmpty(label) || label.Length > QuestionLimits.MaxButtonLabel)
        {
            return $"button needs a label of 1 to {QuestionLimits.MaxButtonLabel} characters.";
        }
        if (url is null || url.Length > QuestionLimits.MaxUrl || !Uri.TryCreate(url, UriKind.Absolute, out var link) || !WebSchemes.Contains(link.Scheme))
        {
            return "button needs a url: an http or https address.";
        }
        question[QuestionFields.Button] = new JsonObject { [QuestionFields.Label] = label, [QuestionFields.Url] = url };
        return null;
    }
}
