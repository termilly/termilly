using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Updates (UpdateCheck.cs): a check soon after start and every 12 hours while Settings › General allows it, and
/// whenever "Check now" asks; offline or a manifest that doesn't verify stays quiet until the next check. A check
/// only shows the notice. The installer is downloaded when the user chooses "Download and install", and installed
/// when they choose "Restart to update": Termilly closes and the installer opens it again.
/// </summary>
internal sealed class UpdateHandler(
    PageChannel page, ISettingsStore settings, UpdateDownload download, IUpdateInstaller installer, IAppWindow window)
    : IMessageHandler, IStartable, IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromHours(12);
    private static readonly TimeSpan First = TimeSpan.FromSeconds(30);
    private const int AllOfIt = 100;

    private readonly Lock _gate = new();
    private Timer? _timer;
    private UpdateManifest? _latest;
    private DateTimeOffset? _checkedAt;
    private int _checking;
    /// <summary>The update the user asked for (null before they do), and how to stop its download.</summary>
    private Asked? _asked;
    private CancellationTokenSource? _cancel;

    /// <summary>An update the user asked for: its version, its installer, where it is and the file once it's downloaded.</summary>
    private sealed record Asked(string Version, UpdatePackage Package, string State, int Percent = 0, string? File = null, string? Message = null, string? Command = null);

    public void Register(MessageRouter router)
    {
        router.On<FromPage.CheckForUpdates>(_ => CheckAsync(manual: true));
        router.On<FromPage.AskUpdateStatus>(_ => PostStatus());
        router.On<FromPage.DownloadUpdate>(_ => Download());
        router.On<FromPage.CancelUpdate>(_ => Cancel());
        router.On<FromPage.InstallUpdate>(_ => InstallAsync());
    }

    public void Start()
    {
        settings.Saved += _ => UpdateTimer();
        UpdateTimer();
        // Installers from an earlier update (it's installed by now, or was given up on).
        _ = Task.Run(download.Clear);
    }

    private void UpdateTimer()
    {
        if (settings.Current.Interface.CheckForUpdates)
        {
            _timer ??= new Timer(_ => _ = CheckAsync(false), null, First, Interval);
        }
        else
        {
            _timer?.Dispose();
            _timer = null;
        }
    }

    private async Task CheckAsync(bool manual)
    {
        if (!manual && !settings.Current.Interface.CheckForUpdates || Interlocked.Exchange(ref _checking, 1) == 1)
        {
            return;
        }
        try
        {
            if (manual)
            {
                page.Post(new ToPage.UpdateChecking());
            }
            var latest = await UpdateCheck.FetchAsync().ConfigureAwait(false);
            _checkedAt = DateTimeOffset.Now;
            if (latest is not null)
            {
                _latest = latest;
            }
            PostStatus(failed: latest is null && manual);
        }
        finally
        {
            Volatile.Write(ref _checking, 0);
        }
    }

    /// <summary>The newer version's installer for this system, if there's a newer version and it can be checked.</summary>
    private (UpdateManifest Latest, UpdatePackage Package)? Offered() =>
        _latest is { } latest && UpdateCheck.IsNewer(latest.Version, AppVersion.Current) && UpdateCheck.Package(latest, OperatingSystem.IsLinux()) is { } package
            ? (latest, package)
            : null;

    private void Download()
    {
        CancellationToken token;
        Asked asked;
        lock (_gate)
        {
            if (Offered() is not { } offered || _asked is { State: UpdateStates.Downloading or UpdateStates.Ready or UpdateStates.Installing } busy && busy.Version == offered.Latest.Version)
            {
                PostStatus();
                return;
            }
            _cancel?.Dispose();
            _cancel = new CancellationTokenSource();
            token = _cancel.Token;
            _asked = asked = new Asked(offered.Latest.Version, offered.Package, UpdateStates.Downloading);
        }
        PostStatus();
        _ = DownloadAsync(asked, token);
    }

    private async Task DownloadAsync(Asked asked, CancellationToken cancel)
    {
        try
        {
            var file = await download.DownloadAsync(asked.Package, new Percent(p => Move(asked, a => a with { Percent = p })), cancel).ConfigureAwait(false);
            Move(asked, a => a with { State = UpdateStates.Ready, Percent = AllOfIt, File = file });
        }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested)
        {
            Move(asked, _ => null);
        }
        catch (OperationCanceledException)
        {
            Move(asked, a => a with { State = UpdateStates.Failed, Message = "The download took too long and was stopped. Try again later." });
        }
        catch (Exception e) when (e is UpdateDownloadException || Storage.IsFileError(e))
        {
            Move(asked, a => a with { State = UpdateStates.Failed, Message = e is UpdateDownloadException ? e.Message : $"Couldn't save the update: {e.Message}" });
        }
    }

    /// <summary>Changes the asked-for update, if it's still <paramref name="asked"/>'s (a newer ask replaced it otherwise), and tells the page.</summary>
    private void Move(Asked asked, Func<Asked, Asked?> change)
    {
        lock (_gate)
        {
            if (_asked is null || _asked.Version != asked.Version || !ReferenceEquals(_asked.Package, asked.Package))
            {
                return;
            }
            _asked = change(_asked);
        }
        PostStatus();
    }

    /// <summary>Stops a download, or puts away a failed update so the notice offers it again.</summary>
    private void Cancel()
    {
        lock (_gate)
        {
            if (_asked is { State: UpdateStates.Downloading })
            {
                _cancel?.Cancel();
                return; // DownloadAsync clears it once the download has stopped
            }
            if (_asked is { State: UpdateStates.Failed or UpdateStates.ByHand })
            {
                _asked = null;
            }
        }
        PostStatus();
    }

    private async Task InstallAsync()
    {
        Asked ready;
        lock (_gate)
        {
            if (_asked is not { State: UpdateStates.Ready, File: { } } asked)
            {
                return;
            }
            _asked = ready = asked with { State = UpdateStates.Installing };
        }
        PostStatus();
        // Checked again: the file waited in the temp folder since it was downloaded.
        if (!UpdateDownload.IsIntact(ready.File!, ready.Package.Sha256))
        {
            Move(ready, a => a with { State = UpdateStates.Failed, File = null, Message = "The downloaded update changed since it was checked, so it wasn't run. Download it again." });
            return;
        }
        var result = await installer.InstallAsync(ready.File!, CancellationToken.None).ConfigureAwait(false);
        if (result.Started)
        {
            window.CloseNow();
        }
        else
        {
            Move(ready, a => result.Command is { } command
                ? a with { State = UpdateStates.ByHand, Command = command }
                : a with { State = UpdateStates.Failed, Message = result.Error });
        }
    }

    /// <summary>The page's view of updates: the running version, the newest known one, when it last looked, and the update asked for.</summary>
    private void PostStatus(bool failed = false)
    {
        ToPage.UpdateAvailable? available = null;
        ToPage.UpdateProgress? progress = null;
        lock (_gate)
        {
            if (_latest is { } latest && UpdateCheck.IsNewer(latest.Version, AppVersion.Current))
            {
                var endsShells = installer.EndsKeptShells || !settings.Current.Session.BackgroundShells;
                available = new ToPage.UpdateAvailable(latest.Version, latest.Date, latest.Notes, Offered() is not null, endsShells, OperatingSystem.IsLinux());
                if (_asked is { } asked && asked.Version == latest.Version)
                {
                    progress = new ToPage.UpdateProgress(asked.State, asked.Percent, asked.Message, asked.Command);
                }
            }
        }
        page.Post(new ToPage.UpdateStatus(AppVersion.Current, _checkedAt?.ToUnixTimeMilliseconds(), failed, available, progress));
    }

    public void Dispose()
    {
        _timer?.Dispose();
        lock (_gate)
        {
            _cancel?.Cancel();
            _cancel?.Dispose();
            _cancel = null;
        }
    }

    /// <summary>Reports a download's percent where it happens (not through a synchronization context, as Progress would).</summary>
    private sealed class Percent(Action<int> report) : IProgress<int>
    {
        public void Report(int value) => report(value);
    }
}
