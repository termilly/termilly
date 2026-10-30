using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>One request to the phone server, as read.</summary>
internal sealed record PhoneRequest(string Method, string Path, Dictionary<string, string> Headers, byte[] Body);

/// <summary>One answer from the phone server: status, type, body and any extra header lines.</summary>
internal readonly record struct PhoneReply(HttpStatusCode Status, string Type, byte[] Content, string Extra = "");

/// <summary>
/// The phone app's API over HTTPS (phone/app.js, docs/phone.md): pairing with the code Settings shows (the phone then
/// holds a token in an HttpOnly cookie), and turning its alerts on, off or testing them. Only a paired phone gets more
/// than "not paired".
/// </summary>
internal sealed class PhoneAppApi(PhoneStore store, string pushKey, Func<string, Task> testAlert)
{
    /// <summary>The token's cookie, and how long a phone keeps it.</summary>
    private const string TokenCookie = "termilly";
    private const int TokenDays = 400;
    private const int SecondsPerDay = 86400;
    /// <summary>The test alert waits this long, so the phone can be locked first.</summary>
    private static readonly TimeSpan TestDelay = TimeSpan.FromSeconds(8);

    /// <summary>The phone app's API (phone/app.js).</summary>
    private static class Api
    {
        public const string Me = "/api/me";
        public const string Pair = "/api/pair";
        public const string Push = "/api/push";
        public const string PushOff = "/api/push/off";
        public const string PushTest = "/api/push/test";
    }

    /// <summary>The fields of the app's requests and answers.</summary>
    private static class Fields
    {
        public const string Paired = "paired";
        public const string Locked = "locked";
        public const string PushKey = "pushKey";
        public const string Alerts = "alerts";
        public const string InSeconds = "inSeconds";
        public const string Code = "code";
        public const string Name = "name";
        public const string Endpoint = "endpoint";
        public const string Keys = "keys";
        public const string P256dh = "p256dh";
        public const string Auth = "auth";
    }

    /// <summary>The push services a phone may hand Termilly: Apple's, Google's, Microsoft's and Mozilla's.</summary>
    private static readonly string[] PushHosts = [".push.apple.com", "fcm.googleapis.com", ".notify.windows.com", ".push.services.mozilla.com"];

    /// <summary>A push service's address Termilly will send to: HTTPS, at one of the known services.</summary>
    public static bool IsPushService(string? endpoint) =>
        Uri.TryCreate(endpoint, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        PushHosts.Any(h => h.StartsWith('.') ? uri.Host.EndsWith(h, StringComparison.OrdinalIgnoreCase) : uri.Host.Equals(h, StringComparison.OrdinalIgnoreCase));

    /// <summary>The paired phone a request comes from (its id), or null.</summary>
    public string? DeviceOf(PhoneRequest request) => store.DeviceFor(TokenFrom(request.Headers.GetValueOrDefault("Cookie")));

    /// <summary>The answer to an API request; null for one it refuses (403).</summary>
    public PhoneReply? Answer(PhoneRequest request)
    {
        if (request.Method != HttpMethod.Post.Method && request.Path != Api.Me)
        {
            return null;
        }
        var device = DeviceOf(request);
        if (request.Path == Api.Me)
        {
            return Json(device is null ? new JsonObject { [Fields.Paired] = false, [Fields.Locked] = store.IsLocked }
                : new JsonObject { [Fields.Paired] = true, [Fields.PushKey] = pushKey, [Fields.Alerts] = store.PushTargets(device).Count > 0 });
        }
        if (request.Path == Api.Pair)
        {
            var token = store.Pair(Field(request.Body, Fields.Code), request.Headers.GetValueOrDefault("User-Agent"), Field(request.Body, Fields.Name));
            return token is null ? null
                : Json(new JsonObject { [Fields.Paired] = true }, $"Set-Cookie: {TokenCookie}={token}; Max-Age={TokenDays * SecondsPerDay}; Path=/; Secure; HttpOnly; SameSite=Strict\r\n");
        }
        if (device is null)
        {
            return null;
        }
        switch (request.Path)
        {
            case Api.Push:
                var target = PushFrom(request.Body);
                if (target is null)
                {
                    return new(HttpStatusCode.BadRequest, MediaTypes.PlainText, []);
                }
                store.SetPush(device, target);
                return Json(new JsonObject { [Fields.Alerts] = true });
            case Api.PushOff:
                store.SetPush(device, null);
                return Json(new JsonObject { [Fields.Alerts] = false });
            case Api.PushTest:
                _ = Task.Delay(TestDelay).ContinueWith(_ => testAlert(device), TaskScheduler.Default);
                return Json(new JsonObject { [Fields.InSeconds] = (int)TestDelay.TotalSeconds });
            default:
                return new(HttpStatusCode.NotFound, MediaTypes.PlainText, []);
        }
    }

    private static PhoneReply Json(JsonObject body, string extra = "") => new(HttpStatusCode.OK, MediaTypes.Json, Encoding.UTF8.GetBytes(body.ToJsonString()), extra);

    /// <summary>The token in the Cookie header, if there is one.</summary>
    private static string? TokenFrom(string? cookies) =>
        cookies?.Split(';').Select(c => c.Trim()).FirstOrDefault(c => c.StartsWith(TokenCookie + "=", StringComparison.Ordinal))?[(TokenCookie.Length + 1)..];

    private static string? Field(byte[] body, string name)
    {
        try
        {
            return (JsonNode.Parse(body) as JsonObject)?[name]?.GetValue<string>();
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }

    /// <summary>A browser's push subscription ({ endpoint, keys: { p256dh, auth } }), if it's one Termilly sends to.</summary>
    private static PushTarget? PushFrom(byte[] body)
    {
        try
        {
            var json = JsonNode.Parse(body) as JsonObject;
            var endpoint = json?[Fields.Endpoint]?.GetValue<string>();
            var keys = json?[Fields.Keys] as JsonObject;
            var p256dh = keys?[Fields.P256dh]?.GetValue<string>();
            var auth = keys?[Fields.Auth]?.GetValue<string>();
            return IsPushService(endpoint) && !string.IsNullOrEmpty(p256dh) && !string.IsNullOrEmpty(auth) ? new PushTarget(endpoint!, p256dh, auth) : null;
        }
        catch (Exception e) when (e is JsonException or InvalidOperationException or FormatException)
        {
            return null;
        }
    }
}
