using System.ComponentModel;
using System.IO;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Phone check-in (CheckinServer.cs, docs/checkin.md): the server runs only while Settings turn it on; a paired phone
/// sees the terminals that need the user, their last lines (redacted here) and can answer a prompt when allowed.
/// </summary>
internal sealed class CheckinHandler : IMessageHandler, IStartable, IDisposable
{
    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly Vault _vault;
    private readonly CheckinDevices _devices;
    private readonly PageApi _api;
    private CheckinServer? _server;
    private int _port;
    private string? _error;

    /// <summary>The phone page's files: wwwroot\phone next to the app.</summary>
    private const string PhoneFolder = "phone";

    /// <summary>What a paired phone asks (phone/phone.js): the terminals' state, one's output, or an answer to its prompt.</summary>
    private static class Operations
    {
        public const string State = "state";
        public const string Output = "output";
        public const string Answer = "answer";
    }

    /// <summary>The fields of the page calls made for a phone, and of their answers.</summary>
    private static class Fields
    {
        public const string Args = PageApi.CallFields.Args;
        public const string Pane = ApiFields.Pane;
        public const string Choice = "choice";
        public const string AllowAnswer = "allowAnswer";
    }

    public CheckinHandler(PageChannel page, ISettingsStore settings, Vault vault, CheckinDevices devices, PageApi api)
    {
        (_page, _settings, _vault, _devices, _api) = (page, settings, vault, devices, api);
        settings.Saved += _ => Update();
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.CheckinStatus>(_ => PostStatus());
        router.On<FromPage.CheckinPair>(_ => OfferPairing());
        router.On<FromPage.CheckinRemove>(m =>
        {
            _devices.Remove(m.Device ?? "");
            PostStatus();
        });
    }

    public void Start()
    {
        _devices.Changed += PostStatus;
        Update();
    }

    /// <summary>Starts or stops the server to match Settings.</summary>
    private void Update()
    {
        var settings = _settings.Current;
        if (_server is not null && (!settings.Checkin.Enabled || _port != settings.Checkin.Port))
        {
            _server.Dispose();
            _server = null;
        }
        _error = null;
        if (settings.Checkin.Enabled && _server is null)
        {
            try
            {
                _server = CheckinServer.Start(settings.Checkin.Port, Path.Combine(AppPaths.WebRoot, PhoneFolder), OperateAsync, _devices);
                _port = settings.Checkin.Port;
            }
            catch (IOException e)
            {
                _error = e.Message;
            }
        }
        PostStatus();
    }

    private void PostStatus() =>
        _page.Post(new ToPage.CheckinStatus(_server is not null, _server?.BaseUrl, _error, _vault.IsLocked ? [] : _devices.List()));

    private void OfferPairing()
    {
        if (_server is null || _vault.IsLocked)
        {
            return;
        }
        var (id, key) = _devices.Offer();
        var secret = Convert.ToBase64String(key).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        _page.Post(new ToPage.CheckinPairing($"{_server.BaseUrl}#{id}.{secret}"));
    }

    /// <summary>What a paired phone asked for; the page knows the terminals, the host redacts their output.</summary>
    private async Task<JsonNode?> OperateAsync(string op, JsonObject args)
    {
        switch (op)
        {
            case Operations.State:
                var state = await _api.AskPageAsync(ToPage.Calls.CheckinState, new JsonObject { [Fields.Args] = new JsonObject() }).ConfigureAwait(false) as JsonObject ?? [];
                state[Fields.AllowAnswer] = _settings.Current.Checkin.Answer;
                return state;
            case Operations.Output:
                var lines = (await _api.AskPageAsync(ToPage.Calls.CheckinOutput, new JsonObject { [Fields.Args] = new JsonObject { [Fields.Pane] = args[Fields.Pane]?.DeepClone() } }).ConfigureAwait(false) as JsonArray ?? [])
                    .Select(l => l?.ToString() ?? "").ToList();
                return new JsonArray(SecretRedactor.Redact(lines).Select(l => (JsonNode)l).ToArray());
            case Operations.Answer:
                if (!_settings.Current.Checkin.Answer)
                {
                    throw new InvalidOperationException("Answering prompts from a phone is off (Settings › Phone check-in).");
                }
                return await _api.AskPageAsync(ToPage.Calls.CheckinAnswer, new JsonObject { [Fields.Args] = new JsonObject { [Fields.Pane] = args[Fields.Pane]?.DeepClone(), [Fields.Choice] = args[Fields.Choice]?.DeepClone() } }).ConfigureAwait(false);
            default:
                throw new InvalidOperationException("Unknown request.");
        }
    }

    public void Dispose()
    {
        _devices.Changed -= PostStatus;
        _server?.Dispose();
    }
}

/// <summary>
/// The AI assistant (Assistant.cs): its API key in the credential store, and questions from its panel. Output and
/// history go along only as Settings allow (the page has asked when it's "Ask"); everything sent is scrubbed of
/// secrets, including the saved SSH passwords. The reply carries what was sent, so it can be checked.
/// </summary>
internal sealed class AiHandler(PageChannel page, ISettingsStore settings, Credentials credentials, Vault vault, CommandHistory commands) : IMessageHandler
{

    public void Register(MessageRouter router)
    {
        router.On<FromPage.AiStatus>(_ => PostStatus());
        router.On<FromPage.AiKey>(m => SaveKey(m.Key));
        router.On<FromPage.AiAsk>(m => Task.Run(() => AskAsync(m)));
    }

    private void PostStatus() =>
        page.Post(new ToPage.AiStatus(credentials.Has(Assistant.KeyTarget), credentials.Store.IsAvailable ? credentials.Store.Name : null));

    /// <summary>Keeps the Anthropic API key in the system's credential store (empty: removes it).</summary>
    private void SaveKey(string? key)
    {
        var store = credentials.Store;
        credentials.Change(() =>
        {
            if (string.IsNullOrWhiteSpace(key))
            {
                store.Delete(Assistant.KeyTarget);
            }
            else
            {
                store.Save(Assistant.KeyTarget, SettingValues.AiProvider.Anthropic, key.Trim(), "Termilly AI assistant API key");
            }
        }, message => page.Post(new ToPage.AiError(message)));
        PostStatus();
    }

    private async Task AskAsync(FromPage.AiAsk msg)
    {
        var current = settings.Current;
        var store = credentials.Store;
        try
        {
            if (current.Ai.Provider == SettingValues.AiProvider.Off)
            {
                throw new InvalidOperationException("The AI assistant is off. Turn it on in Settings › AI.");
            }
            var conversation = (msg.Messages ?? [])
                .Select(m => new AiMessage(m.Role == AiMessage.Assistant ? AiMessage.Assistant : AiMessage.User, m.Content ?? "")).ToList();
            var output = current.Ai.ReadOutput == SettingValues.AiPermission.Never ? null : msg.Output;
            var history = current.Ai.ReadHistory != SettingValues.AiPermission.Never && msg.History && !vault.IsLocked
                ? Assistant.HistoryText(commands.List(current.Session.HistoryDays))
                : null;
            var apiKey = current.Ai.Provider == SettingValues.AiProvider.Anthropic && store.IsAvailable ? store.Read(Assistant.KeyTarget) : null;
            var secrets = store.IsAvailable
                ? (current.Ssh.Connections ?? []).Where(c => c.Identity == SshIdentities.SavedPassword).Select(c => store.Read(c.CredentialTarget)).OfType<string>().ToList()
                : [];
            if (apiKey is not null)
            {
                secrets.Add(apiKey);
            }
            var sent = Assistant.Prepare(conversation, output, msg.OutputName, history, secrets);
            var text = await Assistant.AskAsync(current, apiKey, sent, CancellationToken.None).ConfigureAwait(false);
            page.Post(new ToPage.AiReply(msg.RequestId, text, sent, Assistant.ModelFor(current)));
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or JsonException or Win32Exception)
        {
            page.Post(new ToPage.AiFailed(msg.RequestId, e.Message));
        }
    }
}

/// <summary>History sync between PCs (HistorySync.cs): Settings › Sync between PCs, and a sync every couple of minutes.</summary>
internal sealed class SyncHandler : IMessageHandler, IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(2);
    /// <summary>The first sync, soon after start-up.</summary>
    private static readonly TimeSpan First = TimeSpan.FromSeconds(10);
    /// <summary>A new command is shared this soon after it's run.</summary>
    private static readonly TimeSpan Soon = TimeSpan.FromSeconds(5);

    private readonly PageChannel _page;
    private readonly HistorySync _sync;
    private readonly Timer _timer;

    public SyncHandler(PageChannel page, HistorySync sync)
    {
        (_page, _sync) = (page, sync);
        _timer = new Timer(_ => Tick(), null, First, Interval);
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.SyncStatus>(_ => Answer(() => null));
        router.On<FromPage.SyncOn>(m => Answer(() =>
        {
            var code = _sync.TurnOn(m.Folder ?? "");
            _sync.SyncNow();
            return code;
        }));
        router.On<FromPage.SyncJoin>(m => Answer(() =>
        {
            _sync.Join(m.Folder ?? "", m.Code ?? "");
            _sync.SyncNow();
            return null;
        }));
        router.On<FromPage.SyncNow>(_ => Answer(() =>
        {
            _sync.SyncNow();
            return null;
        }));
        router.On<FromPage.SyncCode>(_ => Answer(_sync.Code));
        router.On<FromPage.SyncRotate>(_ => Answer(_sync.Rotate, rotated: true));
        router.On<FromPage.SyncOff>(_ => Answer(() =>
        {
            _sync.TurnOff();
            return null;
        }));
    }

    /// <summary>A command was just run: share it soon rather than on the next tick.</summary>
    public void ShareSoon() => _timer.Change(Soon, Interval);

    private void Tick()
    {
        try
        {
            _sync.SyncNow();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is InvalidOperationException)
        {
            // Reported in Settings through the status; a sync that fails tries again on the next tick.
        }
    }

    /// <summary>Runs <paramref name="work"/> in the background; every answer is the status, with the code it returns when there's one to show.</summary>
    /// <param name="rotated">The code was just changed: the page says the other PCs need the new one.</param>
    private void Answer(Func<string?> work, bool rotated = false) => _ = Task.Run(() =>
    {
        string? code = null;
        string? message = null;
        try
        {
            code = work();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is CryptographicException)
        {
            message = e.Message;
        }
        _page.Post(new ToPage.SyncStatus(_sync.Status(), code, rotated, message));
    });

    public void Dispose() => _timer.Dispose();
}
