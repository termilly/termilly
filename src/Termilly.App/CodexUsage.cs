using System.IO;
using System.Text.Json;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>Where Codex keeps its files: CODEX_HOME, else ~/.codex.</summary>
internal static class CodexFiles
{
    public const string HomeVariable = "CODEX_HOME";
    public const string Folder = ".codex";
    /// <summary>The rollout files, a folder per day (sessions/2026/11/09/rollout-&lt;time&gt;-&lt;session&gt;.jsonl).</summary>
    public const string Sessions = "sessions";
    /// <summary>The models the account may use, as Codex last fetched them.</summary>
    public const string ModelsCache = "models_cache.json";

    public static string Home() =>
        Environment.GetEnvironmentVariable(HomeVariable) is { } set && !string.IsNullOrWhiteSpace(set)
            ? set
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), Folder);

    /// <summary>Codex's rollout files under a sessions folder.</summary>
    public static UsageSource Source(string sessions, Action<PlanLimits> limits) =>
        new(session => UsageTracker.FindFile(sessions, session, $"rollout-*-{session}.jsonl"), (path, session) => new CodexRollout(path, session, limits));

    public static string SessionsDirectory() => Path.Combine(Home(), Sessions);
}

/// <summary>A model Codex offers in its /model list.</summary>
internal sealed record CodexModel(string Slug, string Name, string? Description);

/// <summary>Codex's models, from its cache of what the account may use (the ones its own /model lists).</summary>
internal static class CodexModels
{
    private const string Listed = "list";

    public static IReadOnlyList<CodexModel> Read(string? home = null)
    {
        try
        {
            using var doc = JsonDocument.Parse(File.ReadAllBytes(Path.Combine(home ?? CodexFiles.Home(), CodexFiles.ModelsCache)));
            return doc.RootElement.ValueKind == JsonValueKind.Object && doc.RootElement.TryGetProperty(Fields.Models, out var models) && models.ValueKind == JsonValueKind.Array
                ? Parse(models)
                : [];
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            return [];
        }
    }

    private static List<CodexModel> Parse(JsonElement models) =>
        models.EnumerateArray()
            .Where(m => m.ValueKind == JsonValueKind.Object && Json.Str(m, Fields.Visibility) == Listed && Json.Str(m, Fields.Slug) is not null)
            .OrderBy(m => Json.Num(m, Fields.Priority))
            .Select(m => new CodexModel(Json.Str(m, Fields.Slug)!, Json.Str(m, Fields.DisplayName) ?? Json.Str(m, Fields.Slug)!, Json.Str(m, Fields.Description)))
            .ToList();

    private static class Fields
    {
        public const string Models = "models";
        public const string Slug = "slug";
        public const string DisplayName = "display_name";
        public const string Description = "description";
        public const string Visibility = "visibility";
        public const string Priority = "priority";
    }
}

/// <summary>
/// Reads the token use out of one Codex rollout file, a little at a time: the model from each turn's settings, and
/// from each token count the totals, how full the context is and the plan's 5-hour and weekly limits. Prompts,
/// replies and tool output are skipped without being decoded.
/// </summary>
internal sealed class CodexRollout(string path, string session, Action<PlanLimits> limits) : IUsageReader
{
    /// <summary>A line this long is a tool's output or a file, never a token count: skipped unread.</summary>
    private const int MaxLine = 4 << 20;
    private const string SessionMeta = "session_meta";
    private const string TurnContext = "turn_context";
    private const string TokenCount = "token_count";
    /// <summary>The limits' windows, in minutes.</summary>
    private const long FiveHourMinutes = 5 * 60;
    private const long WeekMinutes = 7 * 24 * 60;
    private const double MaxPercent = 100;

    private static readonly byte[] MetaMark = "\"session_meta\""u8.ToArray();
    private static readonly byte[] TurnMark = "\"turn_context\""u8.ToArray();
    private static readonly byte[] CountMark = "\"token_count\""u8.ToArray();

    private readonly TranscriptTail _tail = new(path, MaxLine);
    private string? _model;
    private long _window;
    private long _context;
    private long _input;
    private long _cached;
    private long _output;
    private int _replies;
    private string? _version;
    private string? _cwd;
    private DateTimeOffset? _started;
    private DateTimeOffset? _last;

    public ClaudeUsage Usage => new(session, _model, Math.Max(_window, _context), _context, _input - _cached, 0, _cached, _output,
        _replies, 0, _version, GitBranch.Of(_cwd), _started, _last);

    public bool Read() => _tail.Read(Line);

    private bool Line(ReadOnlySpan<byte> line)
    {
        if (line.IndexOf(CountMark) < 0 && line.IndexOf(TurnMark) < 0 && line.IndexOf(MetaMark) < 0)
        {
            return false;
        }
        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object || !root.TryGetProperty(Fields.Payload, out var payload) || payload.ValueKind != JsonValueKind.Object)
            {
                return false;
            }
            var at = Json.Str(root, Fields.Timestamp) is { } stamp && DateTimeOffset.TryParse(stamp, out var when) ? when : (DateTimeOffset?)null;
            return Json.Str(root, Fields.Type) switch
            {
                SessionMeta => Meta(payload, at),
                TurnContext => Turn(payload),
                _ => Json.Str(payload, Fields.Type) == TokenCount && Count(payload, at),
            };
        }
        catch (JsonException)
        {
            return false; // a line still being written, or not JSON
        }
    }

    private bool Meta(JsonElement payload, DateTimeOffset? at)
    {
        _started ??= at;
        _cwd = Json.Str(payload, Fields.Cwd) ?? _cwd;
        _version = Json.Str(payload, Fields.CliVersion) ?? _version;
        return true;
    }

    private bool Turn(JsonElement payload)
    {
        var model = Json.Str(payload, Fields.Model);
        _cwd = Json.Str(payload, Fields.Cwd) ?? _cwd;
        if (model is null || model == _model)
        {
            return false;
        }
        _model = model;
        return true;
    }

    private bool Count(JsonElement payload, DateTimeOffset? at)
    {
        if (payload.TryGetProperty(Fields.RateLimits, out var rates) && rates.ValueKind == JsonValueKind.Object)
        {
            limits(Limits(rates));
        }
        if (!payload.TryGetProperty(Fields.Info, out var info) || info.ValueKind != JsonValueKind.Object)
        {
            return false;
        }
        if (info.TryGetProperty(Fields.Total, out var total) && total.ValueKind == JsonValueKind.Object)
        {
            _input = Json.Num(total, Fields.InputTokens);
            _cached = Json.Num(total, Fields.CachedTokens);
            _output = Json.Num(total, Fields.OutputTokens);
        }
        if (info.TryGetProperty(Fields.LastTurn, out var last) && last.ValueKind == JsonValueKind.Object)
        {
            _context = Json.Num(last, Fields.TotalTokens);
        }
        _window = Json.Num(info, Fields.ContextWindow) is > 0 and var window ? window : _window;
        _replies++;
        _last = at ?? _last;
        return true;
    }

    /// <summary>The plan's windows, told apart by their length (Codex calls them primary and secondary).</summary>
    private static PlanLimits Limits(JsonElement rates)
    {
        PlanWindow? five = null, week = null;
        foreach (var name in (string[])[Fields.Primary, Fields.Secondary])
        {
            if (!rates.TryGetProperty(name, out var w) || w.ValueKind != JsonValueKind.Object || !w.TryGetProperty(Fields.UsedPercent, out var used) || used.ValueKind != JsonValueKind.Number)
            {
                continue;
            }
            var window = new PlanWindow(Math.Clamp(used.GetDouble(), 0, MaxPercent), Json.Num(w, Fields.ResetsAt) is > 0 and var reset ? reset : null);
            switch (Json.Num(w, Fields.WindowMinutes))
            {
                case FiveHourMinutes: five = window; break;
                case WeekMinutes: week = window; break;
            }
        }
        return new PlanLimits(five, week);
    }

    /// <summary>The rollout fields read.</summary>
    private static class Fields
    {
        public const string Timestamp = "timestamp";
        public const string Type = "type";
        public const string Payload = "payload";
        public const string Cwd = "cwd";
        public const string CliVersion = "cli_version";
        public const string Model = "model";
        public const string Info = "info";
        public const string Total = "total_token_usage";
        public const string LastTurn = "last_token_usage";
        public const string InputTokens = "input_tokens";
        public const string CachedTokens = "cached_input_tokens";
        public const string OutputTokens = "output_tokens";
        public const string TotalTokens = "total_tokens";
        public const string ContextWindow = "model_context_window";
        public const string RateLimits = "rate_limits";
        public const string Primary = "primary";
        public const string Secondary = "secondary";
        public const string UsedPercent = "used_percent";
        public const string WindowMinutes = "window_minutes";
        public const string ResetsAt = "resets_at";
    }
}

/// <summary>Reading a JSON element's string or whole-number field, or nothing.</summary>
internal static class Json
{
    public static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}
