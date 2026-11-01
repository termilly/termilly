using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Smart Clip from a phone (phone/clips.js), only while Settings › Phone allows typing and clips: pasting a clip into
/// a terminal (the page pastes its text, as its own Paste would, so the text stays on the PC), or a clip's text for the
/// message box to Claude (never a secret's).
/// </summary>
internal sealed class PhoneClips(ISettingsStore settings, TerminalSessions sessions, ClipStore clips, PageChannel page)
{
    /// <summary>What a phone asks: paste a clip, or send its text.</summary>
    public const string PasteOp = "clip";
    public const string TextOp = "clipText";
    /// <summary>The most of a clip's text the message box gets.</summary>
    public const int MaxText = 20_000;
    private const string OpField = "op";
    private const string PaneField = "pane";
    private const string IdField = "id";
    private const string OkField = "ok";
    private const string ErrorField = "error";
    private const string TextField = "text";

    /// <summary>Pastes a clip into the terminal the phone shows.</summary>
    public JsonObject Paste(JsonObject message)
    {
        var pane = message[PaneField]?.GetValue<string>() ?? "";
        var id = message[IdField]?.GetValue<string>() ?? "";
        if (Refused(PasteOp) is { } off)
        {
            return off;
        }
        if (sessions.Get(pane) is null || clips.TextOf(id) is null)
        {
            return Failed(PasteOp, "That terminal or clip is gone.");
        }
        page.Post(new ToPage.PhoneClip(pane, id));
        return new JsonObject { [OkField] = true, [OpField] = PasteOp };
    }

    /// <summary>A clip's text for the phone's message box (cut short past <see cref="MaxText"/>); a secret's is refused.</summary>
    public JsonObject Text(JsonObject message)
    {
        var id = message[IdField]?.GetValue<string>() ?? "";
        if (Refused(TextOp) is { } off)
        {
            return off;
        }
        if (clips.IsSecret(id))
        {
            return Failed(TextOp, "A secret isn’t sent to the phone. Paste it into the terminal instead.");
        }
        if (clips.TextOf(id) is not { } text)
        {
            return Failed(TextOp, "That clip is gone.");
        }
        return new JsonObject { [OkField] = true, [OpField] = TextOp, [TextField] = text.Length > MaxText ? text[..MaxText] : text };
    }

    private JsonObject? Refused(string op)
    {
        var phone = settings.Current.Phone;
        return phone.AllowTyping && phone.Clips ? null : Failed(op, "Smart Clip on the phone is off: Settings › Phone.");
    }

    private static JsonObject Failed(string op, string error) => new() { [OkField] = false, [OpField] = op, [ErrorField] = error };
}
