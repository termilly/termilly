using System.Text.Json;
using Termilly.Desktop.Security;

namespace Termilly.Desktop;

/// <summary>
/// Persists the page's workspace state (workspaces, layouts, tab names, tags) as an opaque JSON document,
/// encrypted in %LOCALAPPDATA%\Termilly\workspaces.tmw. The page owns the format; the host only stores it.
/// </summary>
internal sealed class WorkspaceStore(Vault vault)
{
    /// <summary>The saved workspaces; null when there are none, or they can't be read (a damaged file starts afresh).</summary>
    public JsonDocument? Load() => vault.ReadJson(vault.WorkspacesPath);

    public void Save(JsonElement state) => vault.WriteSealed(vault.WorkspacesPath, state.GetRawText());
}
