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

    public BackgroundTasksTests() => _tasks = new BackgroundTasks(new PageChannel(_sink), _terminals, new TaskOutputs(_output, _codex), _processes, _clock);

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
        Assert.Equal(TaskStates.Done, (string?)LastList().Single()!["state"]);
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
}
