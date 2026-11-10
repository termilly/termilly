using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// One step of an update at start, as the loader shows it: its line, a smaller note under it, the download's percent
/// (or a bar that just moves, while busy) and whether "Not now" is offered.
/// </summary>
internal sealed record UpdateGateStep(string Line, string? Note = null, int? Percent = null, bool Busy = false, bool CanPutOff = false);

/// <summary>The loader an update at start shows its steps on (UpdateGateWindow on Windows).</summary>
internal interface IStartupUpdateView
{
    void Show(UpdateGateStep step);

    /// <summary>The user chose "Not now" while the update downloaded.</summary>
    event Action? NotNow;
}

/// <summary>
/// What an update at start works with, passed in so it can be tried without a network, a download or setup: the
/// install it updates, the running version, and how to check, download, verify and install.
/// </summary>
internal sealed record StartupUpdateParts(
    string InstallDir,
    string Running,
    Func<CancellationToken, Task<UpdateManifest?>> Fetch,
    Func<UpdateManifest, UpdatePackage?> Package,
    Func<UpdatePackage, IProgress<int>, CancellationToken, Task<string>> Download,
    Func<string, string, bool> Intact,
    Func<bool> KeptShells,
    Func<string, Task<UpdateInstallResult>> Install,
    Func<DateTimeOffset> Now,
    Func<TimeSpan, Task> Wait);

/// <summary>
/// Installs a newer version when Termilly starts (Settings › About › Install updates when Termilly starts), before
/// the window's services, shells or host start: checks for it (5 seconds at most), downloads it with "Not now"
/// offered, checks the download, then hands it to setup and answers true, so this Termilly quits and setup opens the
/// new one. Anything else answers false and Termilly starts as it would have: offline, nothing newer, a version
/// already tried or put off, kept shells running (installing would end them), or the journal can't be written. A
/// failure says why on the loader for a moment first. UpdateJournal keeps it from trying any version twice.
/// </summary>
internal sealed class StartupUpdateGate(StartupUpdateParts parts, IStartupUpdateView view)
{
    /// <summary>How long the check may take before Termilly starts without it.</summary>
    public static readonly TimeSpan CheckBudget = TimeSpan.FromSeconds(5);
    /// <summary>How long a failure's reason stays on the loader before Termilly starts.</summary>
    public static readonly TimeSpan ReasonShown = TimeSpan.FromSeconds(3);

    private readonly string _folder = UpdateJournal.FolderFor(parts.InstallDir);

    /// <summary>True when setup now installs the update and this Termilly should quit; false to start as usual.</summary>
    public async Task<bool> RunAsync()
    {
        using var held = UpdateJournal.TryLock(parts.InstallDir);
        if (held is null || UpdateJournal.Read(_folder) is not { } read)
        {
            return false; // another start is updating this install, or its journal can't be read
        }
        var (journal, outcome) = UpdateJournal.Settle(read, parts.Running);
        if (outcome is not null || !ReferenceEquals(journal, read))
        {
            UpdateJournal.Write(_folder, journal);
        }
        if (outcome is { Failed: true })
        {
            return await FailedAsync($"Couldn't install Termilly {outcome.Version}.").ConfigureAwait(false);
        }
        // An update was just installed (setup started this): no second one on the same start.
        if (outcome is not null || await Task.Run(parts.KeptShells).ConfigureAwait(false))
        {
            return false;
        }
        view.Show(new UpdateGateStep("Checking for updates"));
        using var budget = new CancellationTokenSource(CheckBudget);
        var latest = await parts.Fetch(budget.Token).ConfigureAwait(false);
        if (latest is null || !UpdateJournal.MayTry(journal, latest.Version, parts.Running, parts.Now()) || parts.Package(latest) is not { } package)
        {
            return false;
        }
        journal = UpdateJournal.Start(journal, latest.Version, parts.Running);
        return UpdateJournal.Write(_folder, journal) && await InstallAsync(journal, latest.Version, package).ConfigureAwait(false);
    }

    private async Task<bool> InstallAsync(UpdateJournalData journal, string version, UpdatePackage package)
    {
        string file;
        using (var notNow = new CancellationTokenSource())
        {
            void PutOff() => notNow.Cancel();
            view.NotNow += PutOff;
            try
            {
                var downloading = $"Downloading Termilly {version}";
                view.Show(new UpdateGateStep(downloading, Percent: 0, CanPutOff: true));
                file = await parts.Download(package, new DirectProgress(p => view.Show(new UpdateGateStep(downloading, $"{p}%", p, CanPutOff: true))), notNow.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (notNow.IsCancellationRequested)
            {
                UpdateJournal.Write(_folder, UpdateJournal.PutOff(journal, version, parts.Now()));
                return false;
            }
            catch (OperationCanceledException)
            {
                return await FailedAsync(journal, "The download took too long and was stopped.").ConfigureAwait(false);
            }
            catch (Exception e) when (e is UpdateDownloadException || Storage.IsFileError(e))
            {
                return await FailedAsync(journal, e.Message).ConfigureAwait(false);
            }
            finally
            {
                view.NotNow -= PutOff;
            }
        }
        return await HandOffAsync(journal, version, package, file).ConfigureAwait(false);
    }

    /// <summary>Checks the download, keeps a copy of setup by the journal, writes the hand-off down, then starts setup.</summary>
    private async Task<bool> HandOffAsync(UpdateJournalData journal, string version, UpdatePackage package, string file)
    {
        view.Show(new UpdateGateStep("Checking the download", Busy: true));
        if (!parts.Intact(file, package.Sha256))
        {
            return await FailedAsync(journal, "The download didn't match the update, so it wasn't run.").ConfigureAwait(false);
        }
        var setup = Path.Combine(_folder, UpdateJournal.SetupFile);
        try
        {
            File.Copy(file, setup, overwrite: true);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return await FailedAsync(journal, $"Couldn't keep the update: {e.Message}").ConfigureAwait(false);
        }
        // Written before setup starts: the next start then knows to look for the new version, whatever setup does.
        journal = UpdateJournal.Move(journal, UpdateAttemptStates.HandedOff);
        if (!UpdateJournal.Write(_folder, journal))
        {
            return await FailedAsync(UpdateJournal.Move(journal, UpdateAttemptStates.Failed), "Couldn't write down the update, so it wasn't run.").ConfigureAwait(false);
        }
        view.Show(new UpdateGateStep($"Installing Termilly {version}", Busy: true));
        var result = await parts.Install(setup).ConfigureAwait(false);
        return result.Started || await FailedAsync(journal, result.Error ?? "Setup didn't start.").ConfigureAwait(false);
    }

    /// <summary>Marks the attempt failed, then says why.</summary>
    private Task<bool> FailedAsync(UpdateJournalData journal, string why)
    {
        UpdateJournal.Write(_folder, UpdateJournal.Move(journal, UpdateAttemptStates.Failed));
        return FailedAsync(why);
    }

    /// <summary>Says why on the loader for a moment, then lets Termilly start as it is.</summary>
    private async Task<bool> FailedAsync(string why)
    {
        view.Show(new UpdateGateStep($"Starting Termilly {parts.Running}", why));
        await parts.Wait(ReasonShown).ConfigureAwait(false);
        return false;
    }
}
