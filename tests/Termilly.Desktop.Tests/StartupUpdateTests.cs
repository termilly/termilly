using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>Updates installed when Termilly starts: the journal's rules, and the gate's paths with everything faked.</summary>
public sealed class StartupUpdateTests : IDisposable
{
    private const string Running = "1.0.0";
    private const string Newer = "1.1.0";
    private static readonly string Hash = new('a', 64);
    private static readonly DateTimeOffset Now = new(2026, 11, 10, 12, 0, 0, TimeSpan.Zero);

    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-gate-test-" + Guid.NewGuid().ToString("N"));
    private string InstallDir => Path.Combine(_root, "Termilly");
    private string JournalFolder => UpdateJournal.FolderFor(InstallDir);

    public StartupUpdateTests() => Directory.CreateDirectory(InstallDir);

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    // ---- The journal ----

    [Fact]
    public void A_version_handed_to_setup_is_done_once_it_runs()
    {
        var journal = UpdateJournal.Move(UpdateJournal.Start(new(), Newer, Running), UpdateAttemptStates.HandedOff);

        var (settled, outcome) = UpdateJournal.Settle(journal, Newer);

        Assert.Equal(UpdateAttemptStates.Done, settled.Attempt!.State);
        Assert.Equal(new UpdateOutcome(false, Newer), outcome);
    }

    [Fact]
    public void A_version_handed_to_setup_failed_when_the_old_one_still_runs()
    {
        var journal = UpdateJournal.Move(UpdateJournal.Start(new(), Newer, Running), UpdateAttemptStates.HandedOff);

        var (settled, outcome) = UpdateJournal.Settle(journal, Running);

        Assert.Equal(UpdateAttemptStates.Failed, settled.Attempt!.State);
        Assert.Equal(new UpdateOutcome(true, Newer), outcome);
        Assert.Contains(Newer, settled.TriedVersions);
    }

    [Fact]
    public void A_download_cut_short_fails_quietly_and_stays_tried()
    {
        var (settled, outcome) = UpdateJournal.Settle(UpdateJournal.Start(new(), Newer, Running), Running);

        Assert.Equal(UpdateAttemptStates.Failed, settled.Attempt!.State);
        Assert.Null(outcome);
        Assert.False(UpdateJournal.MayTry(settled, Newer, Running, Now));
    }

    [Fact]
    public void Each_version_gets_one_try_and_only_newer_ones()
    {
        var tried = UpdateJournal.Start(new(), Newer, Running);

        Assert.False(UpdateJournal.MayTry(tried, Newer, Running, Now));
        Assert.True(UpdateJournal.MayTry(tried, "1.1.1", Running, Now));
        Assert.False(UpdateJournal.MayTry(new(), Running, Running, Now));
        Assert.False(UpdateJournal.MayTry(new(), "0.9.0", Running, Now));
    }

    [Fact]
    public void Not_now_puts_a_version_off_for_a_day_without_using_its_try()
    {
        var putOff = UpdateJournal.PutOff(UpdateJournal.Start(new(), Newer, Running), Newer, Now);

        Assert.DoesNotContain(Newer, putOff.TriedVersions);
        Assert.False(UpdateJournal.MayTry(putOff, Newer, Running, Now.AddHours(23)));
        Assert.True(UpdateJournal.MayTry(putOff, Newer, Running, Now.AddHours(25)));
        Assert.True(UpdateJournal.MayTry(putOff, "1.2.0", Running, Now));
    }

    [Fact]
    public void The_journal_is_written_and_read_back_and_a_broken_one_is_not_read()
    {
        var journal = UpdateJournal.Start(new(), Newer, Running);

        Assert.True(UpdateJournal.Write(JournalFolder, journal));
        Assert.Equal(journal.Attempt, UpdateJournal.Read(JournalFolder)!.Attempt);
        Assert.Equal([Newer], UpdateJournal.Read(JournalFolder)!.TriedVersions);

        File.WriteAllText(Path.Combine(JournalFolder, "journal.json"), "{ not json");
        Assert.Null(UpdateJournal.Read(JournalFolder));
    }

    [Fact]
    public void One_update_at_a_time_per_install()
    {
        using (var first = UpdateJournal.TryLock(InstallDir))
        {
            Assert.NotNull(first);
            Assert.Null(UpdateJournal.TryLock(InstallDir));
        }
        using var after = UpdateJournal.TryLock(InstallDir);
        Assert.NotNull(after);
    }

    // ---- The gate ----

    [Fact]
    public async Task A_newer_version_is_downloaded_checked_and_handed_to_setup()
    {
        var fake = new Fake(this);

        Assert.True(await fake.RunAsync());

        Assert.Equal(["Checking for updates", $"Downloading Termilly {Newer}", "Checking the download", $"Installing Termilly {Newer}"], fake.View.Lines);
        Assert.Equal(Path.Combine(JournalFolder, UpdateJournal.SetupFile), fake.Installed);
        Assert.True(File.Exists(fake.Installed));
        Assert.Equal(UpdateAttemptStates.HandedOff, UpdateJournal.Read(JournalFolder)!.Attempt!.State);
    }

    [Fact]
    public async Task Offline_or_nothing_newer_starts_as_usual_without_a_word()
    {
        var fake = new Fake(this) { Latest = null };

        Assert.False(await fake.RunAsync());

        Assert.Equal(["Checking for updates"], fake.View.Lines);
        Assert.Null(UpdateJournal.Read(JournalFolder)!.Attempt);
    }

    [Fact]
    public async Task Kept_shells_mean_no_update_and_no_check()
    {
        var fake = new Fake(this) { KeptShells = true };

        Assert.False(await fake.RunAsync());

        Assert.Empty(fake.View.Lines);
        Assert.Equal(0, fake.Fetched);
    }

    [Fact]
    public async Task Not_now_stops_the_download_and_puts_the_version_off()
    {
        var fake = new Fake(this) { PressNotNow = true };

        Assert.False(await fake.RunAsync());

        var journal = UpdateJournal.Read(JournalFolder)!;
        Assert.Equal(Newer, journal.NotNow);
        Assert.DoesNotContain(Newer, journal.TriedVersions);
        Assert.Null(fake.Installed);
    }

    [Fact]
    public async Task A_failed_download_says_why_and_the_version_is_not_tried_again()
    {
        var fake = new Fake(this) { DownloadError = new UpdateDownloadException("Couldn't download the update: no connection") };

        Assert.False(await fake.RunAsync());
        Assert.Equal(new UpdateGateStep($"Starting Termilly {Running}", "Couldn't download the update: no connection"), fake.View.Steps[^1]);
        Assert.Equal(UpdateAttemptStates.Failed, UpdateJournal.Read(JournalFolder)!.Attempt!.State);

        var again = new Fake(this);
        Assert.False(await again.RunAsync());
        Assert.Equal(0, again.Downloaded);
    }

    [Fact]
    public async Task A_download_that_does_not_check_out_is_never_run()
    {
        var fake = new Fake(this) { IntactDownload = false };

        Assert.False(await fake.RunAsync());

        Assert.Null(fake.Installed);
        Assert.Equal(UpdateAttemptStates.Failed, UpdateJournal.Read(JournalFolder)!.Attempt!.State);
    }

    [Fact]
    public async Task Setup_that_does_not_start_is_a_failure()
    {
        var fake = new Fake(this) { InstallResult = UpdateInstallResult.Failed("Couldn't start setup: denied") };

        Assert.False(await fake.RunAsync());

        Assert.Equal("Couldn't start setup: denied", fake.View.Steps[^1].Note);
        Assert.Equal(UpdateAttemptStates.Failed, UpdateJournal.Read(JournalFolder)!.Attempt!.State);
    }

    [Fact]
    public async Task The_start_after_a_failed_install_says_so_and_does_not_check_again()
    {
        Assert.True(await new Fake(this).RunAsync());

        var next = new Fake(this); // setup started the old version again
        Assert.False(await next.RunAsync());

        Assert.Equal(new UpdateGateStep($"Starting Termilly {Running}", $"Couldn't install Termilly {Newer}."), Assert.Single(next.View.Steps));
        Assert.Equal(0, next.Fetched);
    }

    [Fact]
    public async Task The_start_after_a_good_install_is_quiet()
    {
        Assert.True(await new Fake(this).RunAsync());

        var next = new Fake(this, running: Newer);
        Assert.False(await next.RunAsync());

        Assert.Empty(next.View.Steps);
        Assert.Equal(UpdateAttemptStates.Done, UpdateJournal.Read(JournalFolder)!.Attempt!.State);
    }

    [Fact]
    public async Task Nothing_is_updated_while_another_start_holds_the_install()
    {
        using var other = UpdateJournal.TryLock(InstallDir);
        var fake = new Fake(this);

        Assert.False(await Task.Run(fake.RunAsync));

        Assert.Equal(0, fake.Fetched);
    }

    /// <summary>The gate's view, keeping every step it was shown.</summary>
    private sealed class View : IStartupUpdateView
    {
        public List<UpdateGateStep> Steps { get; } = [];

        /// <summary>Each line once, in order (a download shows its line with each percent).</summary>
        public List<string> Lines => Steps.Select(s => s.Line).Distinct().ToList();

        public event Action? NotNow;

        public void Show(UpdateGateStep step)
        {
            lock (Steps)
            {
                Steps.Add(step);
            }
        }

        public void PressNotNow() => NotNow?.Invoke();
    }

    /// <summary>An update at start with every part faked: the manifest, the download, the check and setup.</summary>
    private sealed class Fake(StartupUpdateTests test, string running = Running)
    {
        public View View { get; } = new();
        public UpdateManifest? Latest { get; init; } = new(Newer, null, null, "https://termilly.com/s.exe", null, null) { WindowsOnlineSha256 = Hash };
        public bool KeptShells { get; init; }
        public bool PressNotNow { get; init; }
        public bool IntactDownload { get; init; } = true;
        public Exception? DownloadError { get; init; }
        public UpdateInstallResult InstallResult { get; init; } = UpdateInstallResult.Running;
        public int Fetched { get; private set; }
        public int Downloaded { get; private set; }
        public string? Installed { get; private set; }

        public Task<bool> RunAsync() => new StartupUpdateGate(new StartupUpdateParts(
            test.InstallDir,
            running,
            _ =>
            {
                Fetched++;
                return Task.FromResult(Latest);
            },
            latest => UpdateCheck.Package(latest, linux: false),
            DownloadAsync,
            (_, _) => IntactDownload,
            () => KeptShells,
            file =>
            {
                Installed = InstallResult.Started ? file : null;
                return Task.FromResult(InstallResult);
            },
            () => Now,
            _ => Task.CompletedTask), View).RunAsync();

        private Task<string> DownloadAsync(UpdatePackage package, IProgress<int> progress, CancellationToken cancel)
        {
            Downloaded++;
            progress.Report(50);
            if (PressNotNow)
            {
                View.PressNotNow();
            }
            cancel.ThrowIfCancellationRequested();
            if (DownloadError is not null)
            {
                throw DownloadError;
            }
            var file = Path.Combine(test._root, package.FileName);
            File.WriteAllText(file, "setup");
            return Task.FromResult(file);
        }
    }
}
