using System.Text.Json.Nodes;

namespace Termilly.Shared;

/// <summary>
/// What an agent asks the user in the notification center (the MCP server's notify_user, the API's notify): pick one of
/// its options, approve or deny, answer in words, or just read an update. The page and the phone show it as a card.
/// </summary>
internal static class QuestionKinds
{
    /// <summary>A question with 1 to 9 choices, one of them maybe recommended: { answer, note? }.</summary>
    public const string Options = "options";
    /// <summary>Approve or Deny, with the details a click away: { approved, note? }.</summary>
    public const string Approve = "approve";
    /// <summary>A text field, with suggestions above it: { answer }.</summary>
    public const string Ask = "ask";
    /// <summary>One line to read, with at most one button; nothing to answer: { delivered }.</summary>
    public const string Info = "info";

    public static readonly string[] All = [Options, Approve, Ask, Info];
}

/// <summary>The fields of a question, of its answer, and of what the agent hears back.</summary>
internal static class QuestionFields
{
    public const string Id = "id";
    public const string Ui = "ui";
    public const string Title = "title";
    public const string Details = "details";
    public const string Choices = "choices";
    public const string Label = "label";
    public const string Recommended = "recommended";
    public const string Suggestions = "suggestions";
    public const string Button = "button";
    public const string Url = "url";
    public const string Answer = "answer";
    public const string Note = "note";
    public const string Approved = "approved";
    public const string Delivered = "delivered";
    /// <summary>The user put it away without an answer (its ×).</summary>
    public const string Skipped = "skipped";
    /// <summary>Termilly couldn't ask: not running, or nobody answered in time.</summary>
    public const string Unavailable = "unavailable";
    /// <summary>Why it couldn't, and what the agent does next.</summary>
    public const string Reason = "reason";
    public const string Next = "next";
}

/// <summary>How much a question may carry.</summary>
internal static class QuestionLimits
{
    public const int MaxChoices = 9;
    /// <summary>The choices a card shows before its More.</summary>
    public const int ShownChoices = 4;
    public const int MaxSuggestions = 6;
    public const int MaxTitle = 200;
    public const int MaxDetails = 4000;
    public const int MaxLabel = 100;
    public const int MaxButtonLabel = 40;
    public const int MaxUrl = 2000;
    /// <summary>The longest answer or note the user may give.</summary>
    public const int MaxAnswer = 4000;
}

/// <summary>What an agent hears back besides the user's answer.</summary>
internal static class QuestionReplies
{
    /// <summary>Nobody could be asked (Termilly isn't running, or no answer came in time): the agent asks in its terminal.</summary>
    public static JsonObject Unavailable(string reason) => new()
    {
        [QuestionFields.Unavailable] = true,
        [QuestionFields.Reason] = reason,
        [QuestionFields.Next] = "Ask the user in your terminal instead.",
    };
}
