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
/// Phone check-in (in Termilly until 1.1.0) kept the paired phones and their keys in checkin.json next to the vault.
/// Now that it's gone, the file is deleted at start so no pairing is left behind.
/// </summary>
internal sealed class RetiredPhonePairings(Vault vault) : IStartable
{
    private const string DevicesFile = "checkin.json";

    public void Start()
    {
        var path = vault.PathOf(DevicesFile);
        if (File.Exists(path))
        {
            Storage.Try(() => File.Delete(path));
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
