using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>Settings › Privacy › History: the summary, clearing part of history and exporting it (HistoryManager).</summary>
internal sealed class HistoryManageHandler(PageChannel page, Vault vault, HistoryManager history, IFileDialogs dialogs, HistoryWatch watch) : IMessageHandler
{
    private const string Locked = "History is locked.";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.HistoryStatsRequest>(m => Task.Run(() =>
        {
            HistoryStats? stats = null;
            Storage.Try(() => stats = vault.IsLocked ? null : history.Stats(m.Open ?? []));
            page.Post(new ToPage.HistoryStatsResult(m.RequestId, stats));
        }));
        router.On<FromPage.HistoryRemove>(m => Task.Run(() =>
        {
            HistoryRemoval? result = null;
            Storage.Try(() => result = vault.IsLocked || m.Plan is null ? null : history.Remove(m.Plan, m.DryRun));
            page.Post(new ToPage.HistoryRemoved(m.RequestId, result, m.DryRun));
            if (!m.DryRun)
            {
                watch.Check();
            }
        }));
        router.On<FromPage.HistoryExport>(async m =>
        {
            if (vault.IsLocked)
            {
                page.Post(new ToPage.HistoryExported(m.RequestId, null, Locked));
                return;
            }
            var file = await dialogs.PickZipToSaveAsync($"termilly-history-{DateTime.Now:yyyy-MM-dd}.zip").ConfigureAwait(false);
            if (file is null)
            {
                page.Post(new ToPage.HistoryExported(m.RequestId, null, null));
                return;
            }
            string? error = null;
            await Task.Run(() =>
            {
                try
                {
                    history.Export(file, (m.Open ?? []).GroupBy(o => o.Id).ToDictionary(g => g.Key, g => g.First().Name));
                }
                catch (Exception e) when (Storage.IsFileError(e) || e is InvalidDataException)
                {
                    error = e.Message;
                }
            }).ConfigureAwait(false);
            page.Post(new ToPage.HistoryExported(m.RequestId, error is null ? file : null, error));
        });
    }
}

/// <summary>
/// Says when history passes the size set in History (Warn me when history passes): soon after start, then each hour
/// and after anything is cleared. Once until it's back under, so "Not now" holds.
/// </summary>
internal sealed class HistoryWatch(PageChannel page, ISettingsStore settings, Vault vault, HistoryManager history) : IStartable, IDisposable
{
    private static readonly TimeSpan First = TimeSpan.FromMinutes(1);
    private static readonly TimeSpan Every = TimeSpan.FromHours(1);
    private const long BytesPerGb = 1L << 30;
    private Timer? _timer;
    private bool _said;

    public void Start() => _timer = new Timer(_ => Check(), null, First, Every);

    public void Check()
    {
        var session = settings.Current.Session;
        if (!session.HistoryWarn || vault.IsLocked)
        {
            return;
        }
        long bytes = 0;
        Storage.Try(() => bytes = history.TotalBytes());
        var limit = session.HistoryWarnGb * BytesPerGb;
        if (bytes <= limit)
        {
            _said = false;
        }
        else if (!_said)
        {
            _said = true;
            page.Post(new ToPage.HistoryOverLimit(bytes, limit));
        }
    }

    public void Dispose() => _timer?.Dispose();
}
