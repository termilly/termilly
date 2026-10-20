using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// What the open terminals showed, so a restart (or a crash) can bring it back: per terminal its last lines and the
/// agent session it ran. Written every half minute while terminals are open and once more on exit, encrypted like
/// the workspaces (session.tms), with secrets redacted when Settings asks. The page owns the shape:
/// { savedAt, tabs: { id: { lines, agentSession, hibernated } } }.
/// </summary>
internal sealed class SessionSnapshot(Vault vault)
{
    /// <summary>Lines kept per terminal: enough to see where things were, small enough to write often.</summary>
    public const int MaxLines = 500;

    private string FilePath => vault.PathOf("session.tms");

    public void Save(JsonElement snapshot, bool redactSecrets)
    {
        if (vault.IsLocked || JsonNode.Parse(snapshot.GetRawText()) is not JsonObject root)
        {
            return;
        }
        if (root["tabs"] is JsonObject tabs)
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
}
