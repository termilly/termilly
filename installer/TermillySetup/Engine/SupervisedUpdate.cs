using System;
using System.IO;
using System.Threading;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>What an update at start exits with, besides ExitCodes.Done and ExitCodes.Failed.</summary>
internal static class SupervisedCodes
{
    /// <summary>Something still ran from the program folder, so nothing changed; a later start tries again.</summary>
    public const int Busy = 2;
    /// <summary>The new version didn't report healthy in time, so the old one is back.</summary>
    public const int RolledBack = 3;
}

/// <summary>
/// An update at start (TermillySetup.exe --quiet --start --update-window --update-supervise --dir DIR), run by the
/// Termilly that found it, from the copy of setup kept in DIR.update. Unlike an update from Settings it never closes
/// anything: it waits for the folder to be free, swaps the files keeping the old ones as DIR.old, starts the new version
/// and keeps it only once its page reports healthy (UpdateSignals.Healthy). Otherwise it puts the old version back and
/// starts that. A sign-in entry (UpdateRegistry) finishes the job if Windows restarts in the middle.
/// </summary>
internal sealed class SupervisedUpdate(Payload payload, string dir, string scope, Action<string> status)
{
    private static readonly TimeSpan FreeWait = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan HealthyWait = TimeSpan.FromSeconds(90);
    private static readonly TimeSpan LockWait = TimeSpan.FromSeconds(10);
    private static readonly TimeSpan PollEvery = TimeSpan.FromMilliseconds(250);
    private const string LockFile = "journal.lock";

    private readonly UpdateFolders _folders = new(dir, UpdateRegistry.VersionOf);

    /// <summary>The old version's number, for the message when it comes back.</summary>
    public string? OldVersion { get; private set; }

    public int Run()
    {
        if (!WaitUntilFree())
        {
            Log.Write("update at start: the program folder is in use, nothing changed");
            Processes.StartTermilly(_folders.Dir);
            return SupervisedCodes.Busy;
        }
        // Held until the update is kept or undone: the new version's own update check sees it and stays out of the way,
        // and no other start or sign-in recovery can move folders in between.
        using var held = TakeLock();
        if (held is null)
        {
            Log.Write("update at start: another update holds this install, nothing changed");
            Processes.StartTermilly(_folders.Dir);
            return SupervisedCodes.Busy;
        }
        Settle(_folders);
        OldVersion = UpdateRegistry.VersionOf(_folders.Dir);
        return InstallFiles() ? StartAndWait() : ExitCodes.Failed;
    }

    /// <summary>
    /// Sign-in recovery (--update-recover --dir DIR): settles an update cut off by a restart. When the folder is still
    /// in use it leaves the sign-in entry for the next time.
    /// </summary>
    public static int Recover(string dir)
    {
        using var held = TakeLock(dir);
        if (held is null)
        {
            return SupervisedCodes.Busy;
        }
        try
        {
            Settle(new UpdateFolders(dir, UpdateRegistry.VersionOf));
            return ExitCodes.Done;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"update recovery couldn't finish, trying again at next sign-in: {e.Message}");
            return ExitCodes.Failed;
        }
    }

    /// <summary>Whatever an earlier update left, settled; the sign-in entry goes only once that worked.</summary>
    private static void Settle(UpdateFolders folders)
    {
        if (folders.Recover())
        {
            Log.Write("an unconfirmed earlier update was rolled back");
        }
        UpdateRegistry.ShowVersionOf(folders.Dir);
        folders.ForgetConfirmed();
        UpdateRegistry.RemoveRecovery();
    }

    /// <summary>The new files in place, the old kept as .old; on any failure the old version is back and started.</summary>
    private bool InstallFiles()
    {
        status($"Installing Termilly {payload.Version}");
        UpdateRegistry.AddRecovery(SetupApp.ExePath, _folders.Dir);
        try
        {
            var options = InstalledTermilly.Find()?.Options ?? new SetupOptions();
            options.InstallDir = _folders.Dir;
            new Installation(payload, options, integrate: false, supervised: true)
                .InstallAsync(p => Log.Write($"{p.Step}: {p.Text}"), CancellationToken.None).GetAwaiter().GetResult();
            var installed = UpdateRegistry.VersionOf(_folders.Dir);
            if (!string.Equals(installed, payload.Version, StringComparison.Ordinal))
            {
                throw new SetupException($"Termilly {installed ?? "(missing)"} is in place instead of {payload.Version}.");
            }
            UpdateRegistry.ShowVersionOf(_folders.Dir);
            return true;
        }
        catch (Exception e) when (e is SetupException or IOException or UnauthorizedAccessException or InvalidDataException)
        {
            Log.Write($"update at start failed while installing: {e}");
            PutOldBack();
            return false;
        }
    }

    /// <summary>Starts the new version and keeps it once it reports healthy; puts the old one back otherwise.</summary>
    private int StartAndWait()
    {
        status($"Starting Termilly {payload.Version}");
        using var healthy = UpdateSignals.Create(scope, UpdateSignals.Healthy);
        healthy.Reset();
        if (Processes.StartTermilly(_folders.Dir) && healthy.WaitOne(HealthyWait))
        {
            Log.Write($"Termilly {payload.Version} reported healthy");
            _folders.Confirm(payload.Version);
            UpdateRegistry.RemoveRecovery();
            return ExitCodes.Done;
        }
        Log.Write($"Termilly {payload.Version} didn't report healthy within {HealthyWait.TotalSeconds:0} s");
        // Only the new version runs from the folder now, started a moment ago by this setup: ending it loses nothing.
        Processes.CloseAll(_folders.Dir);
        PutOldBack();
        return SupervisedCodes.RolledBack;
    }

    /// <summary>
    /// The old version back in the folder and started. If the folder can't be put back now, the sign-in entry stays
    /// and whatever is in the folder starts.
    /// </summary>
    private void PutOldBack()
    {
        try
        {
            _folders.RollBack();
            _folders.Tidy();
            UpdateRegistry.ShowVersionOf(_folders.Dir);
            UpdateRegistry.RemoveRecovery();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"couldn't put the old version back yet, the sign-in entry will: {e.Message}");
            KeepSomeVersion();
        }
        Processes.StartTermilly(_folders.Dir);
    }

    /// <summary>
    /// A rollback that couldn't finish must still leave a Termilly where the shortcuts point: whichever copy is on
    /// disk goes back in the program folder (the old version first).
    /// </summary>
    private void KeepSomeVersion()
    {
        if (UpdateRegistry.VersionOf(_folders.Dir) is not null)
        {
            return;
        }
        try
        {
            _folders.Recover();
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            Log.Write($"no Termilly in the program folder until the sign-in entry runs: {e.Message}");
        }
    }

    private bool WaitUntilFree()
    {
        var until = DateTime.UtcNow + FreeWait;
        while (true)
        {
            var running = Processes.InFolder(_folders.Dir);
            var count = running.Count;
            running.ForEach(p => p.Dispose());
            if (count == 0)
            {
                return true;
            }
            if (DateTime.UtcNow > until)
            {
                return false;
            }
            Thread.Sleep(PollEvery);
        }
    }

    private FileStream? TakeLock() => TakeLock(_folders.Dir);

    /// <summary>The lock Termilly's update check takes too (UpdateJournal.TryLock), tried for a while.</summary>
    private static FileStream? TakeLock(string dir)
    {
        var folder = Path.GetFullPath(dir).TrimEnd('\\') + UpdateFolders.UpdateSuffix;
        var until = DateTime.UtcNow + LockWait;
        while (true)
        {
            try
            {
                Directory.CreateDirectory(folder);
                return new FileStream(Path.Combine(folder, LockFile), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                if (DateTime.UtcNow > until)
                {
                    Log.Write($"couldn't take the update lock: {e.Message}");
                    return null;
                }
                Thread.Sleep(PollEvery);
            }
        }
    }
}
