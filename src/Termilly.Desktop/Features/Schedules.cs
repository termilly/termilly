using System.ComponentModel;
using System.IO;
using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;
using Termilly.Pty;

namespace Termilly.Desktop.Features;

/// <summary>
/// The kept output of schedules' runs, in the vault: a report is what a program printed, so it can hold secrets. One file
/// per run, as they're read one at a time and go by age.
/// </summary>
internal sealed class ScheduleReports(Vault vault)
{
    private const string Folder = "schedule-runs";
    private const string Extension = ".tmr";

    private sealed record Kept(string Output);

    public void Save(string runId, string output)
    {
        if (!IsId(runId))
        {
            return;
        }
        Directory.CreateDirectory(vault.PathOf(Folder));
        vault.WriteSealed(PathOf(runId), JsonSerializer.Serialize(new Kept(output), PageChannel.Json));
    }

    public string? Read(string runId)
    {
        if (!IsId(runId))
        {
            return null;
        }
        using var doc = vault.ReadJson(PathOf(runId));
        return doc?.RootElement.Deserialize<Kept>(PageChannel.Json)?.Output;
    }

    public void Forget(IEnumerable<string> runIds)
    {
        foreach (var id in runIds.Where(IsId))
        {
            File.Delete(PathOf(id));
        }
    }

    private string PathOf(string runId) => vault.PathOf(Path.Combine(Folder, runId + Extension));

    /// <summary>Ids come from the page (store.js newId): nothing in one can lead out of the folder.</summary>
    private static bool IsId(string id) => id.Length > 0 && id.All(char.IsAsciiLetterOrDigit);
}

/// <summary>Schedules (js/schedules.js): the clock, runs out of sight, and their reports.</summary>
internal sealed class ScheduleHandler(PageChannel page, ProfileCatalog profiles, ScheduleReports reports, ScheduleRunner runner)
    : IMessageHandler, IStartable, IDisposable
{
    /// <summary>How often the page looks for what's due. Schedules go by the minute, so this is well under one.</summary>
    private static readonly TimeSpan TickEvery = TimeSpan.FromSeconds(15);
    /// <summary>How much of a run's end the page gets for its summary.</summary>
    private const int TailChars = 16 * 1024;

    private Timer? _clock;

    public void Register(MessageRouter router)
    {
        // A run can take hours, and messages are handled in order: it goes on by itself.
        router.On<FromPage.ScheduleRun>(m => { _ = RunAsync(m); });
        router.On<FromPage.ScheduleStop>(m => runner.Stop(m.RunId));
        router.On<FromPage.ScheduleKeep>(m => Guarded(() => reports.Save(m.RunId, m.Output)));
        router.On<FromPage.ScheduleReportRead>(m => page.Post(new ToPage.ScheduleReport(m.RequestId, reports.Read(m.RunId), ScheduleRunner.Columns)));
        router.On<FromPage.ScheduleForget>(m => Guarded(() => reports.Forget(m.RunIds ?? [])));
    }

    public void Start() => _clock = new Timer(_ => page.Post(new ToPage.ScheduleTick()), null, TickEvery, TickEvery);

    public void Dispose() => _clock?.Dispose();

    private static void Guarded(Action act)
    {
        try
        {
            act();
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            Console.Error.WriteLine($"termilly schedules: {e.Message}");
        }
    }

    private async Task RunAsync(FromPage.ScheduleRun m)
    {
        try
        {
            var result = await runner.RunAsync(JobFor(m)).ConfigureAwait(false);
            Guarded(() => reports.Save(m.RunId, result.Output));
            page.Post(new ToPage.ScheduleEnded(m.RunId, result.ExitCode, SecretRedactor.Redact(Tail(result.Output)), result.Stopped));
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or Win32Exception or NotSupportedException)
        {
            page.Post(new ToPage.ScheduleEnded(m.RunId, null, "", Error: e.Message));
        }
    }

    private static string Tail(string output) => output.Length > TailChars ? output[^TailChars..] : output;

    /// <summary>The hidden shell a run needs. A folder that's gone stops it: the command was written for that folder.</summary>
    private ScheduleJob JobFor(FromPage.ScheduleRun m)
    {
        // Not the default shell instead: the command was written for that shell or server.
        if (m.Profile is { } id && !profiles.Has(id))
        {
            throw new InvalidOperationException("Its shell or server isn't on this PC any more.");
        }
        var profile = profiles.Find(m.Profile);
        if (!OneShot.Supports(profile))
        {
            throw new InvalidOperationException($"{profile.Name} can't run a schedule out of sight. Pick another shell, or a new terminal.");
        }
        var environment = SessionLaunch.EnvironmentFor(profile, AppVersion.Current);
        var limit = TimeSpan.FromSeconds(m.LimitSeconds);
        if (profile.Source == ProfileSources.Ssh)
        {
            var onServer = new PtyOptions(OneShot.CommandLine(profile, m.Command, m.Cwd), ScheduleRunner.Columns, ScheduleRunner.Rows, null, environment);
            return new ScheduleJob(m.RunId, onServer, limit);
        }
        var linuxFolder = profile.Source == ProfileSources.Wsl && profile.WorkingDirectory is null ? WslFolders.LinuxFolder(m.Cwd) : null;
        var requested = profile.WorkingDirectory ?? (linuxFolder is null ? m.Cwd : null);
        var (folder, missing) = AppPaths.StartFolder(requested, null);
        if (missing)
        {
            throw new IOException($"The folder {requested} is gone.");
        }
        var startsIn = linuxFolder is null ? profile : profile with { CommandLine = WslFolders.StartingIn(profile.CommandLine, linuxFolder) };
        return new ScheduleJob(m.RunId, new PtyOptions(OneShot.CommandLine(startsIn, m.Command), ScheduleRunner.Columns, ScheduleRunner.Rows, folder, environment), limit);
    }
}
