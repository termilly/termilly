using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The shell commands each terminal's agent runs in the background (Claude Code's run_in_background): the hooks say
/// when one has started and which task it is, its output file says how it goes and when it ends (there's no hook for
/// that). The page keeps the agent's spinner while any runs, and shows them under the terminal and in its bar. An
/// ended task stays a minute, so the page can say how it went; one whose agent or shell ended goes with it, and so
/// does one whose output file never shows up.
/// </summary>
internal sealed class BackgroundTasks : IMessageHandler, IDisposable
{
    /// <summary>How often running tasks' files are read.</summary>
    private static readonly TimeSpan Every = TimeSpan.FromSeconds(1);
    /// <summary>How long an ended task stays.</summary>
    private static readonly TimeSpan KeepEnded = TimeSpan.FromMinutes(1);
    /// <summary>How long a task's output file may take to show up before the task counts as never started.</summary>
    private static readonly TimeSpan FileWait = TimeSpan.FromSeconds(30);

    private readonly PageChannel _page;
    private readonly TerminalSessions _terminals;
    private readonly ITaskOutput _output;
    private readonly ITaskProcesses _processes;
    private readonly TimeProvider _clock;
    /// <summary>Guards the tasks, and keeps what the page is sent in the order it changed.</summary>
    private readonly Lock _gate = new();
    /// <summary>By terminal, each task by its call.</summary>
    private readonly Dictionary<string, List<Tracked>> _tasks = [];
    private readonly ITimer _timer;

    private sealed class Tracked(string useId, string session, string taskId, string? command, string? description, DateTimeOffset started)
    {
        public string UseId { get; } = useId;
        public string Session { get; } = session;
        public string TaskId { get; } = taskId;
        public string? Command { get; } = command;
        public string? Description { get; } = description;
        public DateTimeOffset Started { get; } = started;
        /// <summary>Its shell, once found: what Stop ends.</summary>
        public TaskProcess? Process { get; set; }
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
        terminals.ShellEnded += Forget;
    }

    public void Register(MessageRouter router) => router.On<FromPage.TaskStop>(m => Stop(m.Id, m.Task));

    /// <summary>An agent hook: a background command started (its id given), or the agent gone (its tasks go with it).</summary>
    public void OnEvent(AgentEvent e)
    {
        if (e is { Event: HookEvents.PostToolUse, Session: { } session, Task: { ToolUseId: { } useId, Id: { } taskId } task })
        {
            Started(e.Pane, new Tracked(useId, session, taskId, task.Command, task.Description, _clock.GetUtcNow()));
        }
        else if (AgentHooks.StateFor(e) == AgentStates.Exited)
        {
            Forget(e.Pane);
        }
    }

    private void Started(string pane, Tracked task)
    {
        lock (_gate)
        {
            var list = _tasks.TryGetValue(pane, out var known) ? known : _tasks[pane] = [];
            if (list.Exists(t => t.UseId == task.UseId))
            {
                return;
            }
            list.Add(task);
            Post(pane);
        }
        // Its shell, found now while it's the newest: Stop then ends that one and no other.
        if (_terminals.Pids().TryGetValue(pane, out var pid))
        {
            _ = Task.Run(() => FindProcess(pane, pid, task));
        }
    }

    private void FindProcess(string pane, int terminalPid, Tracked task)
    {
        HashSet<int> taken;
        lock (_gate)
        {
            taken = [.. (_tasks.GetValueOrDefault(pane) ?? []).Select(t => t.Process?.Pid ?? 0)];
        }
        var found = _processes.Find(terminalPid, task.Started.LocalDateTime, taken);
        lock (_gate)
        {
            task.Process ??= found;
        }
    }

    /// <summary>Reads the running tasks' files; an ended one goes a while after.</summary>
    public void Tick()
    {
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            foreach (var (pane, list) in _tasks.ToList())
            {
                var removed = list.RemoveAll(t => now - t.Ended > KeepEnded || (t.Reading is null && now - t.Started > FileWait)) > 0;
                var read = false;
                foreach (var task in list.Where(t => t.Ended is null))
                {
                    read |= Read(task, now); // every one read, not just up to the first that changed
                }
                if (removed || read)
                {
                    Post(pane);
                }
            }
        }
    }

    /// <summary>Reads one task's file: whether its last line or its state changed.</summary>
    private bool Read(Tracked task, DateTimeOffset now)
    {
        var reading = _output.Read(task.Session, task.TaskId);
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

    /// <summary>The page's Stop: the task's shell and what it runs end; its file then says so.</summary>
    private void Stop(string pane, string? useId)
    {
        TaskProcess? process;
        lock (_gate)
        {
            process = _tasks.GetValueOrDefault(pane)?.Find(t => t.UseId == useId && t.Ended is null)?.Process;
        }
        if (process is not null)
        {
            _ = Task.Run(() => _processes.Stop(process));
        }
    }

    /// <summary>Sends the page a terminal's tasks again (it opened the terminal: one it didn't know missed them).</summary>
    public void Resend(string pane)
    {
        lock (_gate)
        {
            if (_tasks.ContainsKey(pane))
            {
                Post(pane);
            }
        }
    }

    private void Forget(string pane)
    {
        lock (_gate)
        {
            if (_tasks.Remove(pane))
            {
                _page.Post(new ToPage.AgentTasks(pane, []));
            }
        }
    }

    /// <summary>Sends the page a terminal's tasks; called under the gate, so what it gets is in order.</summary>
    private void Post(string pane)
    {
        var list = _tasks.GetValueOrDefault(pane) ?? [];
        if (list.Count == 0)
        {
            _tasks.Remove(pane);
        }
        _page.Post(new ToPage.AgentTasks(pane, [.. list.Select(t => t.View())]));
    }

    public void Dispose() => _timer.Dispose();
}
