using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Terminals' earlier output (EarlierOutput): kept as the page sends it, searched for the page's search, passed on to
/// a reopened terminal, and cleared with what it belonged to.
/// </summary>
internal sealed class EarlierHandler(PageChannel page, ISettingsStore settings, Vault vault, EarlierOutput earlier, HistoryStore history) : IMessageHandler
{
    /// <summary>The field of a history entry naming the terminal whose earlier output it has (js/panes.js recordHistory).</summary>
    public const string EntryField = "earlier";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.EarlierAdd>(m =>
        {
            if (!vault.IsLocked && m.Lines is { Length: > 0 } lines)
            {
                Storage.Try(() => earlier.Append(m.Id, lines, settings.Current.Session.RedactSecrets));
            }
        });
        router.On<FromPage.EarlierSearch>(m => Task.Run(() =>
        {
            IReadOnlyList<EarlierHit> hits = [];
            Storage.Try(() => hits = vault.IsLocked ? [] : earlier.Search(m.Query ?? ""));
            page.Post(new ToPage.EarlierFound(m.RequestId, hits));
        }));
        router.On<FromPage.EarlierTail>(m => Task.Run(() =>
        {
            IReadOnlyList<string> lines = [];
            Storage.Try(() => lines = vault.IsLocked ? [] : earlier.Tail(m.Id, m.Count));
            page.Post(new ToPage.EarlierTailLines(m.RequestId, lines));
        }));
        router.On<FromPage.EarlierMove>(m => Storage.Try(() => earlier.Move(m.From, m.To)));
        router.On<FromPage.EarlierDelete>(m => Storage.Try(() => earlier.Delete(m.Id)));
        router.On<FromPage.EarlierKeep>(m => Task.Run(() => Keep(m.Ids ?? [])));
    }

    /// <summary>Earlier output stays for the open terminals and the closed ones still in history; old chunks go.</summary>
    private void Keep(string[] open)
    {
        if (vault.IsLocked)
        {
            return;
        }
        Storage.Try(() =>
        {
            var days = settings.Current.Session.HistoryDays;
            var keep = new HashSet<string>(open);
            using (var entries = history.List(days))
            {
                foreach (var entry in entries.RootElement.EnumerateArray())
                {
                    if (entry.TryGetProperty(EntryField, out var id) && id.ValueKind == JsonValueKind.String)
                    {
                        keep.Add(id.GetString()!);
                    }
                }
            }
            earlier.KeepOnly(keep);
            earlier.Prune(days);
        });
    }
}
