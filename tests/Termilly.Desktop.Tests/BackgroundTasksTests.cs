extern alias agent;

using System.Collections.Concurrent;
using System.IO;
using System.Text.Json.Nodes;
using agent::Termilly.Agent;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Features;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>An agent's background tasks: what the hooks pass on, and how the app follows each task to its end.</summary>
public sealed class BackgroundTasksTests : IDisposable
{
    private const string Pane = "p1";
    private const string Session = "s1";
    private const string UseId = "toolu_1";
    private const string TaskId = "bk1u88xlt";
    private const string CodexId = "exec-dfeb0971";

    private readonly Sink _sink = new();
    private readonly FakeOutput _output = new();
    private readonly FakeOutput _codex = new(readsWhileRunning: false);
    private readonly FakeProcesses _processes = new();
    private readonly Clock _clock = new();
    private readonly TerminalSessions _terminals = new();
    private readonly BackgroundTasks _tasks;

    private readonly MemorySaved _saved = new();

    public BackgroundTasksTests() => _tasks = NewTasks();

    /// <summary>The app's task follower, as one starting again finds it (the same saved tasks).</summary>
    private BackgroundTasks NewTasks() => new(new PageChannel(_sink), _terminals, new TaskOutputs(_output, _codex), _processes, _clock, _saved);

    private sealed class MemorySaved : ISavedTasks
    {
        public IReadOnlyList<SavedTask> Tasks { get; private set; } = [];
        public IReadOnlyList<SavedTask> Load() => Tasks;
        public void Save(IReadOnlyList<SavedTask> tasks) => Tasks = tasks;
    }

    public void Dispose() => _tasks.Dispose();

    private sealed class Sink : IPageSink
    {
        public ConcurrentQueue<string> Sent { get; } = [];
        public void Send(string json) => Sent.Enqueue(json);
    }

    private sealed class FakeOutput(bool readsWhileRunning = true) : ITaskOutput
    {
        public bool ReadsWhileRunning => readsWhileRunning;
        public List<string> Forgotten { get; } = [];
        public void Forget(string session) => Forgotten.Add(session);
        public TaskReading? Reading { get; set; }
        public TaskReading? Read(string session, string taskId) => session == Session && taskId is TaskId or CodexId ? Reading : null;
    }

    private sealed class FakeProcesses : ITaskProcesses
    {
        public bool Stop(int terminalPid, string outputFile) => true;
        public bool StopCommand(int terminalPid, string command, DateTimeOffset started) => true;
    }

    private sealed class Clock : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = new(2026, 11, 25, 12, 0, 0, TimeSpan.Zero);
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static string Payload(string? taskId = null) => $$"""
        { "session_id": "{{Session}}", "tool_name": "Bash", "tool_use_id": "{{UseId}}",
          "tool_input": { "command": "codex exec review", "description": "Codex review", "run_in_background": true },
          "tool_response": {{(taskId is null ? "null" : $$"""{ "stdout": "", "backgroundTaskId": "{{taskId}}" }""")}} }
        """;

    private static AgentEvent Event(string hookEvent, string? taskId = null) => AgentHooks.Parse(Protocol.Message(Pane, hookEvent, Payload(taskId)))!;

    private static AgentEvent CodexEvent(string hookEvent) => AgentHooks.Parse(Protocol.Message(Pane, hookEvent, $$"""
        { "session_id": "{{Session}}", "tool_name": "Bash", "tool_use_id": "{{CodexId}}", "tool_input": { "command": "npm run dev" } }
        """, "codex"))!;

    private bool TasksSent() => _sink.Sent.Any(j => j.Contains("\"agent:tasks\"", StringComparison.Ordinal));

    /// <summary>The last task list the page got for the pane.</summary>
    private JsonArray LastList()
    {
        var last = _sink.Sent.Select(j => JsonNode.Parse(j)!.AsObject()).Last(m => (string?)m["type"] == "agent:tasks");
        return last["tasks"]!.AsArray();
    }

    [Fact]
    public void A_background_command_passes_on_its_call_command_and_task_id()
    {
        var started = Event("PostToolUse", TaskId);
        Assert.Equal(new ShellTask(UseId, "codex exec review", "Codex review", TaskId), started.Task);
    }

    [Fact]
    public void A_foreground_command_has_no_task()
    {
        var payload = Payload().Replace("\"run_in_background\": true", "\"run_in_background\": false");
        Assert.Null(AgentHooks.Parse(Protocol.Message(Pane, "PreToolUse", payload))!.Task);
    }

    [Fact]
    public void A_task_runs_until_its_file_says_it_exited()
    {
        _tasks.OnEvent(Event("PreToolUse"));
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        Assert.Equal(TaskStates.Running, (string?)LastList().Single()!["state"]);

        _output.Reading = new TaskReading("x.output", "Reading files", null);
        _tasks.Tick();
        Assert.Equal("Reading files", (string?)LastList().Single()!["lastLine"]);

        _output.Reading = new TaskReading("x.output", "all good", 0);
        _tasks.Tick();
        Assert.Equal(TaskStates.Done, (string?)LastList().Single()!["state"]);
    }

    [Fact]
    public void An_ended_task_goes_a_minute_later()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _output.Reading = new TaskReading("x.output", "boom", 2);
        _tasks.Tick();
        Assert.Equal(TaskStates.Failed, (string?)LastList().Single()!["state"]);
        _clock.Now += TimeSpan.FromMinutes(2);
        _tasks.Tick();
        Assert.Empty(LastList());
    }

    [Fact]
    public void A_task_whose_output_file_never_shows_up_goes()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        Assert.Single(LastList());
        _clock.Now += TimeSpan.FromMinutes(1);
        _tasks.Tick();
        Assert.Empty(LastList());
    }

    [Fact]
    public void A_task_that_got_no_id_never_started()
    {
        _tasks.OnEvent(Event("PreToolUse"));
        _tasks.OnEvent(Event("PostToolUse"));
        Assert.DoesNotContain(_sink.Sent, j => j.Contains("\"agent:tasks\"", StringComparison.Ordinal));
    }

    [Fact]
    public void Its_agent_exiting_takes_its_tasks()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _tasks.OnEvent(AgentHooks.Parse(Protocol.Message(Pane, "SessionEnd", $$"""{ "session_id": "{{Session}}" }"""))!);
        Assert.Empty(LastList());
    }

    [Fact]
    public void Every_Codex_command_passes_on_its_call_and_command()
    {
        Assert.Equal(new ShellTask(CodexId, "npm run dev", null, null), CodexEvent("PreToolUse").Task);
    }

    [Fact]
    public void A_Codex_command_that_ends_in_its_turn_is_no_task()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(CodexEvent("PostToolUse"));
        _tasks.OnEvent(CodexEvent("Stop"));
        Assert.False(TasksSent());
    }

    [Fact]
    public void A_Codex_command_still_running_when_the_turn_ends_is_a_task_till_its_rollout_says_it_ended()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        Assert.False(TasksSent());
        _tasks.OnEvent(CodexEvent("Stop"));
        Assert.Equal(TaskStates.Running, (string?)LastList().Single()!["state"]);

        // Nothing to read while it runs, and that doesn't make it a task that never started.
        _clock.Now += TimeSpan.FromMinutes(5);
        _tasks.Tick();
        Assert.Equal(TaskStates.Running, (string?)LastList().Single()!["state"]);

        _codex.Reading = new TaskReading(null, "ready on :3000", 1);
        _tasks.Tick();
        Assert.Equal(TaskStates.Failed, (string?)LastList().Single()!["state"]);
    }

    [Fact]
    public void A_Codex_task_whose_command_reports_its_end_after_all_ends()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(CodexEvent("Stop"));
        _tasks.OnEvent(CodexEvent("PostToolUse"));
        // How it went is still its rollout's to say; if that never does, it's done.
        Assert.Equal(TaskStates.Running, (string?)LastList().Single()!["state"]);
        _clock.Now += TimeSpan.FromMinutes(1);
        _tasks.Tick();
        Assert.Equal(TaskStates.Done, (string?)LastList().Single()!["state"]);
    }

    [Fact]
    public void A_late_end_keeps_the_exit_its_rollout_gives()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(CodexEvent("Stop"));
        _codex.Reading = new TaskReading(null, "boom", 2);
        _tasks.OnEvent(CodexEvent("PostToolUse"));
        Assert.Equal(TaskStates.Failed, (string?)LastList().Single()!["state"]);
    }

    [Fact]
    public void Closing_a_terminal_lets_go_of_the_sessions_of_commands_still_running()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(AgentHooks.Parse(Protocol.Message(Pane, "SessionEnd", $$"""{ "session_id": "{{Session}}" }""", "codex"))!);
        Assert.Equal([Session], _codex.Forgotten);
    }

    [Fact]
    public void A_session_whose_tasks_are_all_gone_isnt_followed_any_longer()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(CodexEvent("Stop"));
        _codex.Reading = new TaskReading(null, "ok", 0);
        _tasks.Tick();
        Assert.Empty(_codex.Forgotten);
        _clock.Now += TimeSpan.FromMinutes(2);
        _tasks.Tick();
        Assert.Equal([Session], _codex.Forgotten);
    }

    [Fact]
    public void A_Codex_agent_exiting_takes_its_running_commands()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(AgentHooks.Parse(Protocol.Message(Pane, "SessionEnd", $$"""{ "session_id": "{{Session}}" }""", "codex"))!);
        _tasks.OnEvent(CodexEvent("Stop"));
        Assert.False(TasksSent());
    }

    [Fact]
    public void A_Codex_rollout_says_when_a_command_ended_and_how()
    {
        const string session = "01a213e3-ab09-79b2-bbe4-125d8524926e";
        var folder = Directory.CreateTempSubdirectory("termilly-codex-").FullName;
        try
        {
            var day = Path.Combine(folder, "2026", "11", "25");
            Directory.CreateDirectory(day);
            var file = Path.Combine(day, $"rollout-2026-11-25T19-06-57-{session}.jsonl");
            File.WriteAllText(file, """{"type":"event_msg","payload":{"type":"task_started"}}""" + "\n");
            var output = new CodexTaskOutput(folder);
            Assert.Null(output.Read(session, CodexId));

            var ended = """{"type":"event_msg","payload":{"type":"item_completed","item":{"type":"CommandExecution","id":"ID","exit_code":0,"aggregated_output":"one\r\ntwo\r\n"}}}""";
            File.AppendAllText(file, ended.Replace("ID", CodexId, StringComparison.Ordinal) + "\n");
            Assert.Equal(new TaskReading(null, "two", 0), output.Read(session, CodexId));
        }
        finally
        {
            Directory.Delete(folder, recursive: true);
        }
    }

    [Fact]
    public void A_task_runs_on_in_a_kept_shell_after_the_app_starts_again()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _output.Reading = new TaskReading("x.output", "tick 3", null);
        _tasks.Dispose();
        _sink.Sent.Clear();

        using var again = NewTasks();
        again.ShellStarted(Pane, kept: true);
        var task = LastList().Single()!;
        Assert.Equal(TaskStates.Running, (string?)task["state"]);
        Assert.Equal("tick 3", (string?)task["lastLine"]);
    }

    [Fact]
    public void A_new_shell_gets_none_of_the_tasks_saved_for_its_terminal()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _output.Reading = new TaskReading("x.output", "tick 3", null);
        _sink.Sent.Clear();

        using var again = NewTasks();
        again.ShellStarted(Pane, kept: false);
        Assert.False(TasksSent());
        Assert.Empty(_saved.Tasks);
    }

    [Fact]
    public void A_saved_task_whose_file_cant_be_read_gets_the_usual_wait_then_goes()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _clock.Now += TimeSpan.FromMinutes(5);

        using var again = NewTasks();
        again.ShellStarted(Pane, kept: true);
        again.Tick();
        Assert.Single(LastList());
        _clock.Now += TimeSpan.FromMinutes(1);
        again.Tick();
        Assert.Empty(LastList());
    }

    [Fact]
    public void An_ended_task_isnt_saved()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));
        _output.Reading = new TaskReading("x.output", "done", 0);
        _tasks.Tick();
        Assert.Empty(_saved.Tasks);
    }

    [Fact]
    public void A_Codex_command_reported_ended_before_a_restart_ends_after_it()
    {
        _tasks.OnEvent(CodexEvent("PreToolUse"));
        _tasks.OnEvent(CodexEvent("Stop"));
        _tasks.OnEvent(CodexEvent("PostToolUse"));
        _clock.Now += TimeSpan.FromMinutes(1);

        using var again = NewTasks();
        again.ShellStarted(Pane, kept: true);
        Assert.Equal(TaskStates.Done, (string?)LastList().Single()!["state"]);
    }

    [Fact]
    public void Tasks_saved_for_a_terminal_not_started_yet_stay_saved()
    {
        _tasks.OnEvent(Event("PostToolUse", TaskId));

        using var again = NewTasks();
        again.ShellStarted("p2", kept: false);
        Assert.Equal([Pane], _saved.Tasks.Select(t => t.Pane));
    }

    [Fact]
    public void Saved_tasks_survive_the_file_and_a_damaged_one_reads_as_none()
    {
        var path = Path.Combine(Path.GetTempPath(), $"termilly-tasks-{Guid.NewGuid():N}.json");
        try
        {
            var file = new SavedTasksFile(path);
            var task = new SavedTask(Pane, "claude", UseId, Session, TaskId, "sleep 60", null, 1);
            file.Save([task]);
            Assert.Equal([task], file.Load());

            File.WriteAllText(path, "[{\"pane\": \"p1\"}, null");
            Assert.Empty(file.Load());
        }
        finally
        {
            File.Delete(path);
        }
    }
}
