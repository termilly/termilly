using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// What the open terminals showed, so a restart (or a crash) can bring it back: per terminal its scrollback and the
/// agent session it ran. Written every half minute while terminals are open and once more on exit, encrypted like
/// the workspaces (session.tms), with secrets redacted when Settings asks. The page owns the shape:
/// { savedAt, tabs: { id: { lines, scroll, agentSession, agentFolder, hibernated, agentStart } } }, scroll being how
/// far back it was scrolled, agentFolder the folder the agent session resumes in and agentStart how the host starts
/// it again before the page is up (<see cref="AgentStart"/>).
/// </summary>
internal sealed class SessionSnapshot(Vault vault)
{
    /// <summary>Lines kept per terminal: its whole scrollback, as much as Settings allows (what scrolled out before is
    /// in its earlier output, EarlierOutput).</summary>
    public const int MaxLines = TerminalSettings.MaxScrollback;

    public string FilePath => vault.PathOf("session.tms");

    /// <summary>The snapshot's terminals, by id.</summary>
    public const string TabsField = "tabs";

    public void Save(JsonElement snapshot, bool redactSecrets)
    {
        if (vault.IsLocked || JsonNode.Parse(snapshot.GetRawText()) is not JsonObject root)
        {
            return;
        }
        if (root[TabsField] is JsonObject tabs)
        {
            foreach (var (_, tab) in tabs)
            {
                if (tab?[TerminalRecordFields.Lines] is not JsonArray lines)
                {
                    continue;
                }
                var text = lines.Select(l => l?.ToString() ?? "").TakeLast(MaxLines).ToList();
                if (redactSecrets)
                {
                    text = SecretRedactor.Redact(text).ToList();
                }
                tab[TerminalRecordFields.Lines] = new JsonArray(text.Select(l => (JsonNode)l).ToArray());
            }
        }
        vault.WriteSealed(FilePath, root.ToJsonString());
    }

    /// <summary>The last snapshot; null when there's none, or it's damaged or from another key.</summary>
    public JsonDocument? Load() => vault.ReadJson(FilePath);

    /// <summary>The agent sessions the last snapshot starts again (<see cref="AgentStart"/>), by terminal.</summary>
    public IReadOnlyList<PlannedStart> AgentStarts()
    {
        using var saved = Load();
        if (saved is null || !saved.RootElement.TryGetProperty(TabsField, out var tabs) || tabs.ValueKind != JsonValueKind.Object)
        {
            return [];
        }
        var starts = new List<PlannedStart>();
        foreach (var tab in tabs.EnumerateObject())
        {
            if (tab.Value.ValueKind == JsonValueKind.Object && tab.Value.TryGetProperty(SnapshotFields.AgentStart, out var start)
                && start.ValueKind == JsonValueKind.Object && Read(start) is { } read)
            {
                starts.Add(new PlannedStart(tab.Name, read));
            }
        }
        return starts;
    }

    /// <summary>A start as the page wrote it; null when it isn't one (a damaged or older snapshot).</summary>
    private static AgentStart? Read(JsonElement start)
    {
        try
        {
            return start.Deserialize<AgentStart>(JsonSerializerOptions.Web);
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
