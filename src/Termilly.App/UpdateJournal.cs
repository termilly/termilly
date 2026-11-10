using System.IO;
using System.Text.Json;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>Where an update installed at start is (the journal's attempt).</summary>
internal static class UpdateAttemptStates
{
    /// <summary>The installer is being downloaded and checked.</summary>
    public const string Downloading = "downloading";
    /// <summary>Setup was started and Termilly closed: the next start finds out whether the new version is in.</summary>
    public const string HandedOff = "handedOff";
    public const string Done = "done";
    public const string Failed = "failed";
}

/// <summary>The update being installed at start: its version, the version it replaces, and how far it got.</summary>
internal sealed record UpdateAttempt(string Version, string From, string Id, string State);

/// <summary>
/// What the journal holds: the attempt, every version already tried automatically (each gets one try), and a version
/// put off with "Not now" until when (Unix milliseconds).
/// </summary>
internal sealed record UpdateJournalData(UpdateAttempt? Attempt = null, IReadOnlyList<string>? Tried = null, string? NotNow = null, long NotNowUntil = 0)
{
    public IReadOnlyList<string> TriedVersions => Tried ?? [];
}

/// <summary>How an earlier attempt turned out, found at the next start; Failed carries the version that didn't install.</summary>
internal sealed record UpdateOutcome(bool Failed, string Version);

/// <summary>
/// The record of updates installed when Termilly starts (StartupUpdateGate), in <c>&lt;install dir&gt;.update</c> next to
/// the program folder, so every data folder using this install finds it, and setup can too. It's written before each
/// step; when it can't be written, nothing is updated. Its rules keep an update from looping: each version gets one
/// automatic try, "Not now" puts a version off for a day, and only a newer version than the running one is tried.
/// </summary>
internal static class UpdateJournal
{
    private const string FolderSuffix = ".update";
    private const string FileName = "journal.json";
    /// <summary>The copy of setup an update runs, kept here rather than in the temp folder Termilly clears.</summary>
    public const string SetupFile = "TermillySetup.exe";
    /// <summary>How long "Not now" puts a version off.</summary>
    public static readonly TimeSpan NotNowFor = TimeSpan.FromHours(24);
    /// <summary>The lock every gate (and setup) takes before reading the journal: one update at a time per install.</summary>
    private const string LockFile = "journal.lock";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>The journal's folder for the install in <paramref name="installDir"/>.</summary>
    public static string FolderFor(string installDir) => Path.TrimEndingDirectorySeparator(Path.GetFullPath(installDir)) + FolderSuffix;

    /// <summary>The journal, or an empty one when there's none yet; null when it's there but can't be read.</summary>
    public static UpdateJournalData? Read(string folder)
    {
        var path = Path.Combine(folder, FileName);
        try
        {
            return File.Exists(path) ? JsonSerializer.Deserialize<UpdateJournalData>(File.ReadAllText(path), Json) ?? new() : new();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            return null;
        }
    }

    /// <summary>Writes the journal; false when it couldn't (a full disk, a folder that can't be written).</summary>
    public static bool Write(string folder, UpdateJournalData journal)
    {
        try
        {
            Directory.CreateDirectory(folder);
            AppPaths.WriteAtomically(Path.Combine(folder, FileName), JsonSerializer.Serialize(journal, Json));
            return true;
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return false;
        }
    }

    /// <summary>
    /// The lock for the install in <paramref name="installDir"/>, held while an update is decided and run: a file in the
    /// journal's folder opened for this process alone, so it works across threads and processes (setup takes it too)
    /// and is let go however the process ends. Null when another holds it, or it can't be had.
    /// </summary>
    public static FileStream? TryLock(string installDir)
    {
        var folder = FolderFor(installDir);
        try
        {
            Directory.CreateDirectory(folder);
            return new FileStream(Path.Combine(folder, LockFile), FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null;
        }
    }

    /// <summary>
    /// The journal once an earlier attempt is settled, and how it went (null when there was none to settle). A version
    /// handed to setup succeeded only if this is that version now; one cut off while downloading counts as failed.
    /// Either way it stays tried.
    /// </summary>
    public static (UpdateJournalData Journal, UpdateOutcome? Outcome) Settle(UpdateJournalData journal, string running)
    {
        if (journal.Attempt is not { State: UpdateAttemptStates.Downloading or UpdateAttemptStates.HandedOff } attempt)
        {
            return (journal, null);
        }
        var installed = attempt.State == UpdateAttemptStates.HandedOff && !UpdateCheck.IsNewer(attempt.Version, running);
        var settled = journal with { Attempt = attempt with { State = installed ? UpdateAttemptStates.Done : UpdateAttemptStates.Failed } };
        // A download cut short (Termilly ended meanwhile) says nothing: the user saw nothing installed.
        return (settled, attempt.State == UpdateAttemptStates.HandedOff ? new UpdateOutcome(!installed, attempt.Version) : null);
    }

    /// <summary>Whether <paramref name="version"/> may be installed automatically now: newer, not tried before, not put off.</summary>
    public static bool MayTry(UpdateJournalData journal, string version, string running, DateTimeOffset now) =>
        UpdateCheck.IsNewer(version, running)
        && !journal.TriedVersions.Contains(version, StringComparer.Ordinal)
        && !(journal.NotNow == version && now.ToUnixTimeMilliseconds() < journal.NotNowUntil);

    /// <summary>The journal with <paramref name="version"/>'s attempt started: tried from now on, whatever happens.</summary>
    public static UpdateJournalData Start(UpdateJournalData journal, string version, string running) => journal with
    {
        Attempt = new UpdateAttempt(version, running, Guid.NewGuid().ToString("N"), UpdateAttemptStates.Downloading),
        Tried = [.. journal.TriedVersions.Where(v => v != version), version],
    };

    /// <summary>
    /// The journal with the attempt put off by "Not now": the version may be tried again once the day is over, so it
    /// isn't counted as tried.
    /// </summary>
    public static UpdateJournalData PutOff(UpdateJournalData journal, string version, DateTimeOffset now) => journal with
    {
        Attempt = null,
        Tried = [.. journal.TriedVersions.Where(v => v != version)],
        NotNow = version,
        NotNowUntil = (now + NotNowFor).ToUnixTimeMilliseconds(),
    };

    /// <summary>The journal with the attempt moved on to <paramref name="state"/>.</summary>
    public static UpdateJournalData Move(UpdateJournalData journal, string state) =>
        journal.Attempt is { } attempt ? journal with { Attempt = attempt with { State = state } } : journal;
}
