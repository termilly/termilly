using System.IO;
using System.Net;
using System.Net.Http;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Termilly on a phone (Settings › Phone, docs/phone.md): starts and stops the phone server with Settings, shows its
/// addresses, pairing codes and the paired phones, and sends alerts to the phones that take them.
/// </summary>
internal sealed class PhoneHandler : IMessageHandler, IStartable, IDisposable
{
    /// <summary>The phone app's files: wwwroot\phone next to the app.</summary>
    private const string PhoneFolder = "phone";
    /// <summary>"When I'm away": the PC untouched this long counts as away, even with Termilly in front.</summary>
    public static readonly TimeSpan AwayAfter = TimeSpan.FromSeconds(60);
    /// <summary>The longest text an alert carries; the lock screen shows a few lines anyway.</summary>
    private const int MaxBody = 180;
    /// <summary>Agent states (AgentStates) whose alert says an agent finished; the rest say it needs the user.</summary>
    private static readonly string[] Finished = [AgentStates.Done];
    /// <summary>An alert's fields, as phone/sw.js shows it.</summary>
    private static class Alert
    {
        public const string Title = "title";
        public const string Body = "body";
        public const string Tag = "tag";
    }

    /// <summary>Alerts give up on a push service this slow.</summary>
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(15);

    private static readonly HttpClient Http = new() { Timeout = SendTimeout };

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly PhoneStore _store;
    private readonly PhoneLive _live;
    private readonly PageApi _api;
    private readonly PhoneOutput _output;
    private readonly TerminalSessions _sessions;
    private PhoneServer? _server;
    private int _port;
    private string? _error;

    public PhoneHandler(PageChannel page, ISettingsStore settings, PhoneStore store, PhoneLive live, PageApi api, PhoneOutput output, TerminalSessions sessions)
    {
        (_page, _settings, _store, _live, _api, _output, _sessions) = (page, settings, store, live, api, output, sessions);
        settings.Saved += _ => Update();
        live.Received = ReceivedAsync;
        live.Recent = output.Recent;
        live.Sized = (pane, size) => _page.Post(new ToPage.PhoneSize(pane, size?.Cols, size?.Rows));
        output.Printed += live.Output;
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.PhoneStatus>(_ => Update());
        router.On<FromPage.PhonePair>(_ =>
        {
            if (_server is not null && !_store.IsLocked)
            {
                _page.Post(new ToPage.PhonePairing(_store.OfferCode()));
            }
        });
        router.On<FromPage.PhoneRemove>(m =>
        {
            _store.Remove(m.Device ?? "");
            _live.CloseAll(); // the others connect again; the removed phone can't
        });
        router.On<FromPage.PhoneState>(m => _live.SetState(m.State.GetRawText()));
        router.On<FromPage.PhoneAlert>(async m =>
        {
            var settings = _settings.Current.Phone;
            if (_server is not null && ShouldAlert(settings.Alerts, m.InFront, UserIdle.Since()))
            {
                await AlertAsync(null, AlertFor(m, settings.HideDetails)).ConfigureAwait(false);
            }
        });
        router.On<FromPage.PhoneTest>(async _ =>
        {
            var (sent, error) = await AlertAsync(null, TestAlert).ConfigureAwait(false);
            _page.Post(new ToPage.PhoneTested(sent, error));
        });
    }

    public void Start()
    {
        _store.Changed += PostStatus;
        Update();
    }

    /// <summary>The alert a test sends.</summary>
    private static JsonObject TestAlert => new() { [Alert.Title] = AlertTitle, [Alert.Body] = "Alerts reach this phone." };

    /// <summary>An alert's title when it isn't about one terminal.</summary>
    private const string AlertTitle = "Termilly";

    /// <summary>Whether an agent's news goes to the phones: never, always, or while the user is away from the PC.</summary>
    public static bool ShouldAlert(string mode, bool inFront, TimeSpan? idle) => mode switch
    {
        SettingValues.PhoneAlerts.Always => true,
        SettingValues.PhoneAlerts.Away => !inFront || idle >= AwayAfter,
        _ => false,
    };

    /// <summary>
    /// The alert: the page's title and text (secrets taken out, cut short), or with details hidden only what happened.
    /// One per terminal on the lock screen: a newer one replaces the older (its tag).
    /// </summary>
    public static JsonObject AlertFor(FromPage.PhoneAlert m, bool hideDetails)
    {
        if (hideDetails)
        {
            return new JsonObject { [Alert.Title] = AlertTitle, [Alert.Body] = Finished.Contains(m.State) ? "An agent finished." : "An agent needs you.", [Alert.Tag] = m.Id };
        }
        var body = SecretRedactor.Redact(m.Body ?? "");
        return new JsonObject
        {
            [Alert.Title] = m.Title ?? AlertTitle, [Alert.Body] = body.Length > MaxBody ? body[..(MaxBody - 1)].TrimEnd() + "…" : body, [Alert.Tag] = m.Id,
        };
    }

    /// <summary>What a phone may ask: an answer to a waiting agent (approve, always, reject), or a reply in its own words.</summary>
    private static readonly string[] Choices = ["approve", "always", "reject", "reply"];
    /// <summary>The fields of a phone's answer to an agent, and of what it hears back.</summary>
    private static class Answer
    {
        public const string Pane = "pane";
        public const string Choice = "choice";
        public const string Text = "text";
        public const string Ok = "ok";
        public const string Error = "error";
    }

    /// <summary>What a phone types into the terminal it watches, at most this much at a time.</summary>
    private const int MaxInput = 4096;
    private const string InputOp = "input";
    private const string OpField = "op";
    private const string DataField = "data";

    /// <summary>A phone sent something: keys for the terminal it watches, or an answer to an agent.</summary>
    private Task<JsonObject> ReceivedAsync(string device, JsonObject message) =>
        message[OpField]?.GetValue<string>() == InputOp ? Task.FromResult(Type(message)) : AnswerAsync(device, message);

    /// <summary>Keys from a phone, typed into the terminal: only while Settings › Phone allows typing.</summary>
    private JsonObject Type(JsonObject message)
    {
        var pane = message[Answer.Pane]?.GetValue<string>() ?? "";
        var data = message[DataField]?.GetValue<string>() ?? "";
        if (!_settings.Current.Phone.AllowTyping)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = "Typing from the phone is off: Settings › Phone › Allow typing." };
        }
        if (data.Length is 0 or > MaxInput || _sessions.Get(pane) is not { } session)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = "That terminal is gone." };
        }
        session.Write(data);
        return new JsonObject { [Answer.Ok] = true, [OpField] = InputOp };
    }

    /// <summary>The longest reply a phone may type to an agent.</summary>
    private const int MaxReply = 4000;

    /// <summary>
    /// A phone answers an agent: the page checks the terminal still waits, then types the answer (js/phone.js). The
    /// phone hears back whether it went through.
    /// </summary>
    private async Task<JsonObject> AnswerAsync(string device, JsonObject message)
    {
        var choice = message[Answer.Choice]?.GetValue<string>();
        var text = message[Answer.Text]?.GetValue<string>() ?? "";
        if (!Choices.Contains(choice) || text.Length > MaxReply)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = "Not something a phone can ask." };
        }
        try
        {
            await _api.AskPageAsync(ToPage.Calls.PhoneAnswer, new JsonObject
            {
                [PageApi.CallFields.Args] = new JsonObject { [Answer.Pane] = message[Answer.Pane]?.DeepClone(), [Answer.Choice] = choice, [Answer.Text] = text },
            }).ConfigureAwait(false);
            return new JsonObject { [Answer.Ok] = true, [Answer.Pane] = message[Answer.Pane]?.DeepClone() };
        }
        catch (InvalidOperationException e)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = e.Message, [Answer.Pane] = message[Answer.Pane]?.DeepClone() };
        }
    }

    /// <summary>Starts or stops the server to match Settings (and the vault: nothing runs while it's locked).</summary>
    private void Update()
    {
        var settings = _settings.Current.Phone;
        if (_server is not null && (!settings.Enabled || _port != settings.Port || _store.IsLocked))
        {
            _live.CloseAll();
            _output.Keeping = false;
            _output.Clear();
            _server.Dispose();
            _server = null;
        }
        _error = null;
        if (settings.Enabled && _server is null)
        {
            if (_store.IsLocked)
            {
                _error = "Unlock Termilly first.";
            }
            else
            {
                try
                {
                    using var authority = _store.Authority(Environment.MachineName);
                    using var vapid = _store.Vapid();
                    _server = PhoneServer.Start(settings.Port, Path.Combine(AppPaths.WebRoot, PhoneFolder), _store, _live, authority, WebPush.PublicKey(vapid),
                        device => AlertAsync(device, TestAlert));
                    _port = settings.Port;
                    _output.Keeping = true;
                }
                catch (IOException e)
                {
                    _error = e.Message;
                }
            }
        }
        PostStatus();
    }

    private void PostStatus() => _page.Post(new ToPage.PhoneStatus(_server is not null, _server?.SetupUrl, _server?.AppUrl, _error, _store.List()));

    /// <summary>
    /// An alert to the phones that take them (or just one): how many it reached, and why not when none did. A phone
    /// whose subscription is gone stops taking alerts.
    /// </summary>
    private async Task<(int Sent, string? Error)> AlertAsync(string? only, JsonObject alert)
    {
        var targets = _store.PushTargets(only);
        if (targets.Count == 0)
        {
            return (0, "No phone takes alerts yet: turn them on in the phone app.");
        }
        using var vapid = _store.Vapid();
        var sent = 0;
        string? error = null;
        foreach (var (id, target) in targets)
        {
            try
            {
                var status = await WebPush.SendAsync(Http, vapid, target, alert.ToJsonString(), CancellationToken.None).ConfigureAwait(false);
                if (status is HttpStatusCode.NotFound or HttpStatusCode.Gone)
                {
                    _store.SetPush(id, null);
                }
                else if (status is >= HttpStatusCode.OK and < HttpStatusCode.MultipleChoices)
                {
                    sent++;
                }
                else
                {
                    error = $"The push service answered {(int)status}.";
                }
            }
            catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
            {
                error = $"Couldn't reach the push service: {e.Message}";
            }
        }
        return (sent, sent > 0 ? null : error);
    }

    public void Dispose()
    {
        _store.Changed -= PostStatus;
        _live.CloseAll();
        _server?.Dispose();
    }
}
