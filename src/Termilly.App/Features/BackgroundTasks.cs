using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The shell commands each terminal's agent runs in the background (Claude Code's run_in_background): the hooks say
/// when one starts and which task it is, its output file says how it goes and when it ends (there's no hook for
/// that). The page keeps the agent's spinner while any runs, and shows them under the terminal and in its bar. An
/// ended task stays a minute, so the page can say how it went; one whose agent exited goes with it.
/// </summary>
internal sealed class BackgroundTasks : IMessageHandler, IDisposable
{
    /// <summary>How often running tasks' files are read.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(1);
    /// <summary>How long an ended task stays.</summary>
    private static readonly TimeSpan KeepEnded = TimeSpan.FromMinutes(1);

    private readonly PageChannel _page;
    private readonly TerminalSessions _terminals;
    private readonly ITaskOutput _output;
    private readonly ITaskProcesses _processes;
    private readonly TimeProvider _clock;
    private readonly Lock _gate = new();
    /// <summary>By terminal, each task by its call (its id comes after it started).</summary>
    private readonly Dictionary<string, List<Tracked>> _tasks = [];
    private readonly ITimer _timer;

    private sealed class Tracked(string useId, string? session, string? command, string? description, DateTimeOffset started)
    {
        public string UseId { get; } = useId;
        public string? Session { get; } = session;
        public string? Command { get; } = command;
        public string? Description { get; } = description;
        public DateTimeOffset Started { get; } = started;
        public string? TaskId { get; set; }
        public TaskReading? Reading { get; set; }
        public DateTimeOffset? Ended { get; set; }

        public TaskView View() => new(UseId, Command, Description, Started.ToUnixTimeMilliseconds(),
            Reading?.ExitCode is { } code ? (code == 0 ? TaskStates.Done : TaskStates.Failed) : TaskStates.Running,
            Reading?.ExitCode, Reading?.LastLine, Reading?.Path, Ended?.ToUnixTimeMilliseconds());
    }

    public BackgroundTasks(PageChannel page, TerminalSessions terminals, ITaskOutput output, ITaskProcesses processes, TimeProvider clock)
    {
        (_page, _terminals, _output, _processes, _clock) = (page, terminals, output, processes, clock);
        _timer = clock.CreateTimer(_ => Tick(), null, Every, Every);
        terminals.Closed += Forget;
        terminals.Restarting += Forget;
    }

    public void Register(MessageRouter router) => router.On<FromPage.TaskStop>(m => Stop(m.Id, m.Task));

    /// <summary>An agent hook: a background command starting or started, or the agent gone (its tasks go with it).</summary>
    public void OnEvent(AgentEvent e)
    {
        if (e.Task is { ToolUseId: { } useId } task)
        {
            Started(e.Pane, e.Session, useId, task, e.Event == HookEvents.PostToolUse);
        }
        else if (AgentHooks.StateFor(e) == AgentStates.Exited)
        {
            Forget(e.Pane);
        }
    }

    private void Started(string pane, string? session, string useId, ShellTask task, bool afterCall)
    {
        lock (_gate)
        {
            var list = _tasks.TryGetValue(pane, out var known) ? known : _tasks[pane] = [];
            var tracked = list.Find(t => t.UseId == useId);
            if (tracked is null)
            {
                tracked = new Tracked(useId, session, task.Command, task.Description, _clock.GetUtcNow());
                list.Add(tracked);
            }
            // After the call, a task without an id never started (the command was refused or failed at once).
            if (afterCall && task.Id is null)
            {
                list.Remove(tracked);
            }
            tracked.TaskId ??= task.Id;
        }
        Post(pane);
    }

    /// <summary>Reads the running tasks' files; an ended one goes a while after.</summary>
    public void Tick()
    {
        var changed = new List<string>();
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            foreach (var (pane, list) in _tasks)
            {
                var removed = list.RemoveAll(t => now - t.Ended > KeepEnded) > 0;
                var read = list.Where(t => t.Ended is null && t.TaskId is not null && t.Session is not null).Any(t => Read(t, now));
                if (removed || read)
                {
                    changed.Add(pane);
                }
            }
        }
        changed.ForEach(Post);
    }

    /// <summary>Reads one task's file: whether its last line or its state changed.</summary>
    private bool Read(Tracked task, DateTimeOffset now)
    {
        var reading = _output.Read(task.Session!, task.TaskId!);
        if (reading is null || reading == task.Reading)
        {
            return false;
        }
        task.Reading = reading;
        if (reading.ExitCode is not null)
        {
            task.Ended = now;
        }
        return true;
    }

    /// <summary>The page's Stop: the task's process and what it runs end; its file then says so.</summary>
    private void Stop(string pane, string? useId)
    {
        DateTimeOffset? started;
        lock (_gate)
        {
            started = _tasks.GetValueOrDefault(pane)?.Find(t => t.UseId == useId && t.Ended is null)?.Started;
        }
        if (started is { } at && _terminals.Pids().TryGetValue(pane, out var pid))
        {
            _ = Task.Run(() => _processes.Stop(pid, at.LocalDateTime));
        }
    }

    private void Forget(string pane)
    {
        bool had;
        lock (_gate)
        {
            had = _tasks.Remove(pane);
        }
        if (had)
        {
            _page.Post(new ToPage.AgentTasks(pane, []));
        }
    }

    private void Post(string pane)
    {
        TaskView[] views;
        lock (_gate)
        {
            views = [.. (_tasks.GetValueOrDefault(pane) ?? []).Select(t => t.View())];
            if (views.Length == 0)
            {
                _tasks.Remove(pane);
            }
        }
        _page.Post(new ToPage.AgentTasks(pane, views));
    }

    public void Dispose() => _timer.Dispose();
}
