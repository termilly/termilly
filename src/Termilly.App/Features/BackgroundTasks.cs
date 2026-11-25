using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The shell commands each terminal's agent runs in the background. Claude Code's (run_in_background): the hooks say
/// when one has started and which task it is, its output file says how it goes and when it ends (there's no hook for
/// that). Codex's: its hooks report each command before it runs and after it ends, but not the end of one left running,
/// so one still running when the turn ends is a task, and its rollout says when it ends. The page keeps the agent's
/// spinner while any runs, and shows them under the terminal and in its bar. An ended task stays a minute, so the page
/// can say how it went; one whose agent or shell ended goes with it, and so does a Claude task whose output file never
/// shows up.
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
    private readonly ITaskOutput _claude;
    private readonly ITaskOutput _codex;
    private readonly ITaskProcesses _processes;
    private readonly TimeProvider _clock;
    /// <summary>Guards the tasks, and keeps what the page is sent in the order it changed.</summary>
    private readonly Lock _gate = new();
    /// <summary>By terminal, each task by its call.</summary>
    private readonly Dictionary<string, List<Tracked>> _tasks = [];
    /// <summary>By terminal, Codex's commands that haven't reported their end: each a task if the turn ends first.</summary>
    private readonly Dictionary<string, List<Tracked>> _running = [];
    private readonly ITimer _timer;

    private sealed class Tracked(string agent, string useId, string session, string taskId, string? command, string? description, DateTimeOffset started)
    {
        public string Agent { get; } = agent;
        public string UseId { get; } = useId;
        public string Session { get; } = session;
        public string TaskId { get; } = taskId;
        public string? Command { get; } = command;
        public string? Description { get; } = description;
        public DateTimeOffset Started { get; } = started;
        public TaskReading? Reading { get; set; }
        public DateTimeOffset? Ended { get; set; }

        public TaskView View() => new(UseId, Command, Description, Started.ToUnixTimeMilliseconds(),
            Reading?.ExitCode is { } code ? (code == 0 ? TaskStates.Done : TaskStates.Failed) : TaskStates.Running,
            Reading?.ExitCode, Reading?.LastLine, Reading?.Path, Ended?.ToUnixTimeMilliseconds());
    }

    public BackgroundTasks(PageChannel page, TerminalSessions terminals, TaskOutputs outputs, ITaskProcesses processes, TimeProvider clock)
    {
        (_page, _terminals, _claude, _codex, _processes, _clock) = (page, terminals, outputs.Claude, outputs.Codex, processes, clock);
        _timer = clock.CreateTimer(_ => Tick(), null, Every, Every);
        terminals.Closed += Forget;
        terminals.Restarting += Forget;
        terminals.ShellEnded += ShellEnded;
    }

    public void Register(MessageRouter router) => router.On<FromPage.TaskStop>(m => Stop(m.Id, m.Task));

    /// <summary>
    /// An agent hook: a background command started (its id given), a Codex command started or ended, a Codex turn
    /// ended (what still runs is a task), or the agent gone (its tasks go with it).
    /// </summary>
    public void OnEvent(AgentEvent e)
    {
        if (e.Agent == AgentKinds.Codex)
        {
            OnCodexEvent(e);
        }
        else if (e is { Event: HookEvents.PostToolUse, Session: { } session, Task: { ToolUseId: { } useId, Id: { } taskId } task })
        {
            lock (_gate)
            {
                Started(e.Pane, new Tracked(e.Agent, useId, session, taskId, task.Command, task.Description, _clock.GetUtcNow()));
            }
        }
        if (AgentHooks.StateFor(e) == AgentStates.Exited)
        {
            Forget(e.Pane);
        }
    }

    private void OnCodexEvent(AgentEvent e)
    {
        lock (_gate)
        {
            if (e is { Event: HookEvents.PreToolUse, Session: { } session, Task: { ToolUseId: { } useId } task })
            {
                var list = _running.TryGetValue(e.Pane, out var known) ? known : _running[e.Pane] = [];
                list.Add(new Tracked(e.Agent, useId, session, useId, task.Command, task.Description, _clock.GetUtcNow()));
            }
            else if (e is { Event: HookEvents.PostToolUse, Task.ToolUseId: { } ended })
            {
                _running.GetValueOrDefault(e.Pane)?.RemoveAll(t => t.UseId == ended);
                // Late news of one taken for a task already: it ended (its exit isn't said).
                if (_tasks.GetValueOrDefault(e.Pane)?.Find(t => t.UseId == ended && t.Ended is null) is { } promoted)
                {
                    promoted.Reading = new TaskReading(null, promoted.Reading?.LastLine, 0);
                    promoted.Ended = _clock.GetUtcNow();
                    Post(e.Pane);
                }
            }
            else if (e.Event is HookEvents.Stop or HookEvents.Interrupt && _running.Remove(e.Pane, out var left))
            {
                // Posted before the page hears the turn ended, so its "done" waits for them.
                left.ForEach(t => Started(e.Pane, t));
            }
        }
    }

    /// <summary>A new task (one known already is left as it is); called under the gate.</summary>
    private void Started(string pane, Tracked task)
    {
        var list = _tasks.TryGetValue(pane, out var known) ? known : _tasks[pane] = [];
        if (list.Exists(t => t.UseId == task.UseId))
        {
            return;
        }
        list.Add(task);
        Post(pane);
    }

    private ITaskOutput OutputOf(Tracked task) => task.Agent == AgentKinds.Codex ? _codex : _claude;

    /// <summary>Reads the running tasks' output; an ended one goes a while after.</summary>
    public void Tick()
    {
        lock (_gate)
        {
            var now = _clock.GetUtcNow();
            foreach (var (pane, list) in _tasks.ToList())
            {
                var gone = list.FindAll(t => now - t.Ended > KeepEnded || NeverStarted(t, now));
                list.RemoveAll(gone.Contains);
                Release(gone);
                var removed = gone.Count > 0;
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

    /// <summary>A Claude task whose output file never showed up.</summary>
    private bool NeverStarted(Tracked task, DateTimeOffset now) =>
        task.Reading is null && OutputOf(task).ReadsWhileRunning && now - task.Started > FileWait;

    /// <summary>Reads one task's output: whether its last line or its state changed.</summary>
    private bool Read(Tracked task, DateTimeOffset now)
    {
        var reading = OutputOf(task).Read(task.Session, task.TaskId);
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

    /// <summary>
    /// The page's Stop: the task's shell and what it runs end, found by its output file (Claude's) or its command
    /// (Codex's); its output then says so.
    /// </summary>
    private void Stop(string pane, string? useId)
    {
        Tracked? task;
        lock (_gate)
        {
            task = _tasks.GetValueOrDefault(pane)?.Find(t => t.UseId == useId && t.Ended is null);
        }
        if (task is null || !_terminals.Pids().TryGetValue(pane, out var pid))
        {
            return;
        }
        if (task.Reading?.Path is { } file)
        {
            _ = Task.Run(() => _processes.Stop(pid, file));
        }
        else if (task.Agent == AgentKinds.Codex && task.Command is { } command)
        {
            _ = Task.Run(() => _processes.StopCommand(pid, command, task.Started));
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

    /// <summary>A terminal's shell ended, unless it has a new shell already: then it's an old one's late news.</summary>
    private void ShellEnded(string pane)
    {
        lock (_gate)
        {
            // Checked under the gate: a new shell's tasks are added under it too, so they can't come in between.
            if (!_terminals.Pids().ContainsKey(pane))
            {
                ForgetLocked(pane);
            }
        }
    }

    private void Forget(string pane)
    {
        lock (_gate)
        {
            ForgetLocked(pane);
        }
    }

    private void ForgetLocked(string pane)
    {
        _running.Remove(pane);
        if (_tasks.Remove(pane, out var gone))
        {
            Release(gone);
            _page.Post(new ToPage.AgentTasks(pane, [], Gone: true));
        }
    }

    /// <summary>The outputs these tasks were read from stop being followed, once no other task of their session is left.</summary>
    private void Release(List<Tracked> gone)
    {
        foreach (var task in gone.DistinctBy(t => (t.Agent, t.Session)))
        {
            if (!_tasks.Values.Concat(_running.Values).Any(list => list.Exists(t => t.Agent == task.Agent && t.Session == task.Session)))
            {
                OutputOf(task).Forget(task.Session);
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

/// <summary>Where each agent's background tasks are read from.</summary>
internal sealed record TaskOutputs(ITaskOutput Claude, ITaskOutput Codex);
