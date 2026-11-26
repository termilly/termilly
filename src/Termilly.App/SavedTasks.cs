using System.IO;
using System.Text.Json;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// A running background task, as saved: its terminal, its agent, its call and session, the task id that names its
/// output, what it runs and why, when it started, and when its own hook said it ended (a Codex command's, late, its
/// exit still to be read). Times in Unix milliseconds.
/// </summary>
internal sealed record SavedTask(string Pane, string Agent, string UseId, string Session, string TaskId, string? Command,
    string? Description, long Started, long? Reported = null)
{
    private static readonly long Latest = DateTimeOffset.MaxValue.ToUnixTimeMilliseconds();

    /// <summary>Whether it names a task and its times are times (a file edited or cut short by hand may not).</summary>
    public bool Valid => this is { Pane: not null, Agent: not null, UseId: not null, Session: not null, TaskId: not null }
        && IsTime(Started) && (Reported is null || IsTime(Reported.Value));

    private static bool IsTime(long ms) => ms >= 0 && ms <= Latest;
}

/// <summary>
/// The background tasks being followed, kept across a restart: the hook that says a task started comes once, so a
/// window opened again over shells the background host kept learns their tasks from here (BackgroundTasks).
/// </summary>
internal interface ISavedTasks
{
    /// <summary>The tasks saved last; none when there's no file or it can't be read.</summary>
    IReadOnlyList<SavedTask> Load();

    void Save(IReadOnlyList<SavedTask> tasks);
}

/// <summary>The saved tasks in background-tasks.json in the data folder.</summary>
internal sealed class SavedTasksFile : ISavedTasks
{
    private const string FileName = "background-tasks.json";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    private readonly string _path;

    public SavedTasksFile()
        : this(Path.Combine(AppPaths.DataDirectory, FileName))
    {
    }

    /// <param name="path">The file (a test's own).</param>
    internal SavedTasksFile(string path) => _path = path;

    public IReadOnlyList<SavedTask> Load()
    {
        try
        {
            var saved = File.Exists(_path) ? JsonSerializer.Deserialize<List<SavedTask?>>(File.ReadAllText(_path), Json) : null;
            return [.. (saved ?? []).OfType<SavedTask>().Where(t => t.Valid)];
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            return [];
        }
    }

    public void Save(IReadOnlyList<SavedTask> tasks) =>
        Storage.Try(() => AppPaths.WriteAtomically(_path, JsonSerializer.Serialize(tasks, Json)));
}
