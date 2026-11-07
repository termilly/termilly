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
/// Termilly on a phone (Settings › Remote, docs/phone.md): starts and stops the phone server with Settings, shows its
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
        /// <summary>What a tap on it opens: the app on its terminal (phone/app.js OPEN_PARAM).</summary>
        public const string Url = "url";
    }

    /// <summary>The phone app, opening on this terminal.</summary>
    private static string OpenUrl(string? pane) => pane is null ? "/" : "/?open=" + Uri.EscapeDataString(pane);

    /// <summary>Alerts give up on a push service this slow.</summary>
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(15);

    private static readonly HttpClient Http = new() { Timeout = SendTimeout };

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly PhoneStore _store;
    private readonly PhoneLive _live;
    private readonly PageApi _api;
    private readonly TerminalSessions _sessions;
    private readonly PhoneClips _clips;
    private PhoneServer? _server;
    /// <summary>Alerts held while the user was at the PC (When I'm away), sent once the PC is left alone.</summary>
    private readonly PhoneAwayAlerts _away;
    private int _port;
    private string? _error;

    /// <summary>Another Termilly computer's Copy to, which the server takes too.</summary>
    private readonly PcFilesApi _files;
    /// <summary>Another Termilly computer's Prompt history, which the server takes too.</summary>
    private readonly PcPromptsApi _prompts;
    /// <summary>The computers this one shows (Remote › Termilly computers): none of them may show this one too.</summary>
    private readonly RemotePcStore _computers;

    /// <summary>The name of the computer this one shows with that authority fingerprint; null when it shows none.</summary>
    private string? ShownComputer(string fingerprint) =>
        _computers.List().FirstOrDefault(pc => PcConnection.FingerprintOf(Convert.FromBase64String(pc.Authority)) == fingerprint)?.Name;

    public PhoneHandler(PageChannel page, ISettingsStore settings, PhoneStore store, PhoneLive live, PageApi api, TerminalSessions sessions, PhoneClips clips,
        PcFilesApi files, RemotePcStore computers, PcPromptsApi prompts)
    {
        (_page, _settings, _store, _live, _api, _sessions, _clips, _files, _computers, _prompts) = (page, settings, store, live, api, sessions, clips, files, computers, prompts);
        settings.Saved += _ => Update();
        live.Received = ReceivedAsync;
        live.Screen = ScreenAsync;
        live.Sized = (pane, phone) => _page.Post(SizeOf(pane, phone, phone is null ? null : store.List().FirstOrDefault(d => d.Id == phone.Device)?.Name));
        live.Opened = pane => _page.Post(new ToPage.PhoneSeen(pane));
        live.Watchers = (pane, names) => _page.Post(new ToPage.PhoneViewers(pane, names));
        live.NameOf = device => store.List().FirstOrDefault(d => d.Id == device)?.Name is { } name
            ? name.EndsWith(PcConnection.ComputerMark, StringComparison.Ordinal) ? name[..^PcConnection.ComputerMark.Length] : name
            : null;
        sessions.Output += Printed;
        _away = new PhoneAwayAlerts(alert => AlertAsync(null, alert), UserIdle.Since, AwayAfter);
    }

    /// <summary>The size a phone (or another Termilly computer) gives a terminal, and who it is; none when no one shows it.</summary>
    private static ToPage.PhoneSize SizeOf(string pane, PhoneLive.Viewer? phone, string? name)
    {
        var computer = name?.EndsWith(PcConnection.ComputerMark, StringComparison.Ordinal) == true;
        return new ToPage.PhoneSize(pane, phone?.Size.Cols, phone?.Size.Rows, computer ? name![..^PcConnection.ComputerMark.Length] : name, phone?.Address, computer);
    }

    /// <summary>A terminal printed something: it goes on to the phones that show it (while the server runs).</summary>
    private void Printed(string pane, string data)
    {
        if (_server is not null)
        {
            _live.Output(pane, data);
        }
    }

    /// <summary>What a terminal shows now, drawn again as output, from the window's own terminal (js/phone.js).</summary>
    private async Task<string> ScreenAsync(string pane)
    {
        var answer = await _api.AskPageAsync(ToPage.Calls.PhoneScreen, new JsonObject
        {
            [PageApi.CallFields.Args] = new JsonObject { [Answer.Pane] = pane },
        }).ConfigureAwait(false);
        return answer?[DataField]?.GetValue<string>() ?? "";
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
            if (m.Id is { } id && _live.IsShownOnPhone(id))
            {
                _page.Post(new ToPage.PhoneSeen(id)); // seen on the phone as it came: not news on the PC either
            }
            _away.Drop(m.Id); // a newer one replaces it
            if (_server is null)
            {
                return;
            }
            var alert = AlertFor(m, settings.HideDetails);
            if (ShouldAlert(settings.Alerts, m.InFront, UserIdle.Since()))
            {
                await AlertAsync(null, alert).ConfigureAwait(false);
            }
            else if (settings.Alerts == SettingValues.PhoneAlerts.Away)
            {
                _away.Hold(m.Id, alert); // the user is at the PC now; it goes if they leave before it's answered
            }
        });
        router.On<FromPage.PhoneWithdraw>(m => _away.Drop(m.Id));
        router.On<FromPage.PhoneTakeBack>(m => _live.TakeBack(m.Id));
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
    /// <summary>The state a schedule's alert comes with (js/schedules.js): no agent is involved.</summary>
    private const string ScheduleAlert = "schedule";

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
            return new JsonObject { [Alert.Title] = AlertTitle, [Alert.Body] = m.State == ScheduleAlert ? "A schedule ran." : Finished.Contains(m.State) ? "An agent finished." : "An agent needs you.", [Alert.Tag] = m.Id, [Alert.Url] = OpenUrl(m.Id) };
        }
        var body = SecretRedactor.Redact(m.Body ?? "");
        return new JsonObject
        {
            [Alert.Title] = m.Title ?? AlertTitle, [Alert.Body] = body.Length > MaxBody ? body[..(MaxBody - 1)].TrimEnd() + "…" : body, [Alert.Tag] = m.Id, [Alert.Url] = OpenUrl(m.Id),
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
    private Task<JsonObject> ReceivedAsync(string device, JsonObject message) => message[OpField]?.GetValue<string>() switch
    {
        InputOp => Task.FromResult(Type(message)),
        PhoneClips.PasteOp => Task.FromResult(_clips.Paste(message)),
        PhoneClips.TextOp => Task.FromResult(_clips.Text(message)),
        ManageOp => ManageAsync(device, message),
        _ => AnswerAsync(device, message),
    };

    private const string ManageOp = "manage";
    /// <summary>Who asked, by name, added here: what's sent can't say it's someone else.</summary>
    private const string ByField = "by";
    private const string ActionField = "action";

    /// <summary>
    /// A phone or another computer opens or closes workspaces and terminals (Settings › Remote › Allow creating, Allow
    /// closing), renames or moves a terminal or adds an SSH host (Allow typing). The page does it and says how it went
    /// (js/phonemanage.js).
    /// </summary>
    private async Task<JsonObject> ManageAsync(string device, JsonObject message)
    {
        var action = message[ActionField]?.GetValue<string>();
        if (PhoneManage.Refused(action, _settings.Current.Phone) is { } setting)
        {
            return new JsonObject { [Answer.Ok] = false, [OpField] = ManageOp, [ActionField] = action, [Answer.Error] = $"That's off on this PC: Settings › Remote › {setting}." };
        }
        try
        {
            var args = (JsonObject)message.DeepClone();
            args[ByField] = _live.NameOf?.Invoke(device);
            var done = await _api.AskPageAsync(ToPage.Calls.PhoneManage, new JsonObject { [PageApi.CallFields.Args] = args }, PhoneManage.Wait(action)).ConfigureAwait(false);
            var answer = done?.DeepClone() as JsonObject ?? [];
            answer[Answer.Ok] = true;
            answer[OpField] = ManageOp;
            return answer;
        }
        catch (InvalidOperationException e)
        {
            return new JsonObject { [Answer.Ok] = false, [OpField] = ManageOp, [ActionField] = action, [Answer.Error] = e.Message };
        }
    }

    /// <summary>Keys from a phone, typed into the terminal: only while Settings › Remote allows typing.</summary>
    private JsonObject Type(JsonObject message)
    {
        var pane = message[Answer.Pane]?.GetValue<string>() ?? "";
        var data = message[DataField]?.GetValue<string>() ?? "";
        if (!_settings.Current.Phone.AllowTyping)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = "Typing from the phone is off: Settings › Remote › Allow typing." };
        }
        if (data.Length is 0 or > MaxInput || _sessions.Get(pane) is not { } session)
        {
            return new JsonObject { [Answer.Ok] = false, [Answer.Error] = "That terminal is gone." };
        }
        session.Write(data);
        if (data.Length == 1)
        {
            _page.Post(new ToPage.PhoneTyped(pane, data)); // Enter, Esc or a number may answer the agent
        }
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
                        device => AlertAsync(device, TestAlert), _files, ShownComputer, _prompts);
                    _port = settings.Port;
                }
                catch (IOException e)
                {
                    _error = e.Message;
                }
            }
        }
        PostStatus();
    }

    private void PostStatus() => _page.Post(new ToPage.PhoneStatus(_server is not null, _server?.SetupUrl, _server?.AppUrl, _error, _store.List(), Environment.MachineName));

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
            // A phone with the app open shows the news already; a test goes anyway.
            if (only is null && _live.IsOpenOn(id))
            {
                continue;
            }
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
        _sessions.Output -= Printed;
        _live.CloseAll();
        _server?.Dispose();
        _away.Dispose();
    }
}
