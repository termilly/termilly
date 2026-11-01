using System.Globalization;
using System.Text.Json;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>A prompt Termilly recorded: the terminal it was sent in, its Claude Code session, the text and when (ISO 8601, UTC).</summary>
internal sealed record StoredPrompt(string Pane, string? Session, string Text, string At);

/// <summary>
/// The prompts sent to Claude Code in Termilly's terminals (My prompts), kept in the vault like the command history:
/// as long as Settings › Workspaces keep history, secrets redacted when Settings say, cleared with it. The page sends
/// them (not for a terminal that keeps no history), from the prompt hook (Termilly.Agent/Protocol.cs).
/// </summary>
internal sealed class PromptHistory(Vault vault)
{
    private const string FileName = "prompts.tmw";
    /// <summary>At most this many prompts are kept (the newest).</summary>
    public const int MaxKept = 5000;
    /// <summary>How a prompt's time is written: as Claude Code's transcripts write theirs, so the two sort together.</summary>
    private const string TimeFormat = "yyyy-MM-dd'T'HH:mm:ss.fff'Z'";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);
    private readonly Lock _lock = new();
    private List<StoredPrompt>? _prompts;

    private string FilePath => vault.PathOf(FileName);

    /// <summary>Keeps a prompt (not while history is locked); older ones than history keeps, and the oldest past the limit, go.</summary>
    public void Add(string pane, string? session, string text, bool redact, int retentionDays, DateTimeOffset? at = null)
    {
        var trimmed = text.Trim();
        if (vault.IsLocked || pane.Length == 0 || trimmed.Length == 0)
        {
            return;
        }
        var prompt = new StoredPrompt(pane, session, redact ? SecretRedactor.Redact(trimmed) : trimmed,
            (at ?? DateTimeOffset.UtcNow).UtcDateTime.ToString(TimeFormat, CultureInfo.InvariantCulture));
        lock (_lock)
        {
            var prompts = Load();
            prompts.Add(prompt);
            Expire(prompts, retentionDays);
            if (prompts.Count > MaxKept)
            {
                prompts.RemoveRange(0, prompts.Count - MaxKept);
            }
            Save(prompts);
        }
    }

    /// <summary>A terminal's prompts, oldest first, within the days history keeps.</summary>
    public IReadOnlyList<StoredPrompt> Of(string? pane, int retentionDays)
    {
        if (string.IsNullOrEmpty(pane) || vault.IsLocked)
        {
            return [];
        }
        lock (_lock)
        {
            var prompts = Load();
            if (Expire(prompts, retentionDays) > 0)
            {
                Save(prompts);
            }
            return prompts.Where(p => p.Pane == pane).ToList();
        }
    }

    /// <summary>Forgets every prompt (history cleared).</summary>
    public void Clear()
    {
        lock (_lock)
        {
            _prompts = [];
            vault.WriteSealed(FilePath, JsonSerializer.Serialize(_prompts, Json));
        }
    }

    private List<StoredPrompt> Load()
    {
        if (_prompts is null)
        {
            using var doc = vault.ReadJson(FilePath);
            _prompts = doc?.RootElement.Deserialize<List<StoredPrompt>>(Json) ?? [];
        }
        return _prompts;
    }

    private void Save(List<StoredPrompt> prompts) => vault.WriteSealed(FilePath, JsonSerializer.Serialize(prompts, Json));

    /// <summary>Drops what's older than history keeps; how many went.</summary>
    private static int Expire(List<StoredPrompt> prompts, int retentionDays)
    {
        var cutoff = Retention.CutoffMs(retentionDays);
        return cutoff == long.MinValue ? 0 : prompts.RemoveAll(p =>
            DateTimeOffset.TryParse(p.At, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var when) && when.ToUnixTimeMilliseconds() < cutoff);
    }
}
