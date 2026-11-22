using System.Text.Json.Nodes;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Phone;

/// <summary>
/// A paired phone answers an agent's question in the notification center (Shared/Questions.cs): a choice or words, an
/// Approve or Deny with a note, or putting it away. Answering needs no Allow typing, as answering an agent's permission
/// doesn't: nothing is typed into a terminal. The page checks the question still waits and that the answer fits it
/// (js/questions.js); the phone hears back whether it went through.
/// </summary>
internal static class PhoneQuestions
{
    /// <summary>The op a phone's message has (phone/app.js).</summary>
    public const string Op = "question";

    /// <summary>A phone's message's fields, beyond the answer's own (QuestionFields).</summary>
    private static class Fields
    {
        public const string Op = "op";
        public const string Ok = "ok";
        public const string Error = "error";
        /// <summary>True when the user put the question away without an answer.</summary>
        public const string Skip = "skip";
    }

    public static async Task<JsonObject> AnswerAsync(PageApi api, JsonObject message)
    {
        var id = message[QuestionFields.Id].AsText();
        var answer = message[QuestionFields.Answer].AsText();
        var note = message[QuestionFields.Note].AsText();
        if (string.IsNullOrEmpty(id) || answer?.Length > QuestionLimits.MaxAnswer || note?.Length > QuestionLimits.MaxAnswer)
        {
            return Reply(id, "Not something a phone can answer.");
        }
        var args = new JsonObject
        {
            [QuestionFields.Id] = id,
            [QuestionFields.Answer] = answer,
            [QuestionFields.Approved] = message[QuestionFields.Approved].AsBool(),
            [QuestionFields.Note] = note,
            [Fields.Skip] = message[Fields.Skip].AsBool() == true,
        };
        try
        {
            await api.AskPageAsync(ToPage.Calls.PhoneQuestion, new JsonObject { [PageApi.CallFields.Args] = args }).ConfigureAwait(false);
            return Reply(id, null);
        }
        catch (InvalidOperationException e)
        {
            return Reply(id, e.Message);
        }
    }

    private static JsonObject Reply(string? id, string? error) => new()
    {
        [Fields.Ok] = error is null,
        [Fields.Op] = Op,
        [QuestionFields.Id] = id,
        [Fields.Error] = error,
    };
}
