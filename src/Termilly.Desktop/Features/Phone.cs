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
    /// <summary>Alerts give up on a push service this slow.</summary>
    private static readonly TimeSpan SendTimeout = TimeSpan.FromSeconds(15);

    private static readonly HttpClient Http = new() { Timeout = SendTimeout };

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly PhoneStore _store;
    private PhoneServer? _server;
    private int _port;
    private string? _error;

    public PhoneHandler(PageChannel page, ISettingsStore settings, PhoneStore store)
    {
        (_page, _settings, _store) = (page, settings, store);
        settings.Saved += _ => Update();
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
        router.On<FromPage.PhoneRemove>(m => _store.Remove(m.Device ?? ""));
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
    private static JsonObject TestAlert => new() { ["title"] = AlertTitle, ["body"] = "Alerts reach this phone." };

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
            return new JsonObject { ["title"] = AlertTitle, ["body"] = Finished.Contains(m.State) ? "An agent finished." : "An agent needs you.", ["tag"] = m.Id };
        }
        var body = SecretRedactor.Redact(m.Body ?? "");
        return new JsonObject
        {
            ["title"] = m.Title ?? AlertTitle, ["body"] = body.Length > MaxBody ? body[..(MaxBody - 1)].TrimEnd() + "…" : body, ["tag"] = m.Id,
        };
    }

    /// <summary>Starts or stops the server to match Settings (and the vault: nothing runs while it's locked).</summary>
    private void Update()
    {
        var settings = _settings.Current.Phone;
        if (_server is not null && (!settings.Enabled || _port != settings.Port || _store.IsLocked))
        {
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
                    _server = PhoneServer.Start(settings.Port, Path.Combine(AppPaths.WebRoot, PhoneFolder), _store, authority, WebPush.PublicKey(vapid),
                        device => AlertAsync(device, TestAlert));
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
        _server?.Dispose();
    }
}
