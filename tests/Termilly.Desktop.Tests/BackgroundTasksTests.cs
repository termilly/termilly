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

    private readonly Sink _sink = new();
    private readonly FakeOutput _output = new();
    private readonly FakeProcesses _processes = new();
    private readonly Clock _clock = new();
    private readonly TerminalSessions _terminals = new();
    private readonly BackgroundTasks _tasks;

    public BackgroundTasksTests() => _tasks = new BackgroundTasks(new PageChannel(_sink), _terminals, _output, _processes, _clock);

    public void Dispose() => _tasks.Dispose();

    private sealed class Sink : IPageSink
    {
        public ConcurrentQueue<string> Sent { get; } = [];
        public void Send(string json) => Sent.Enqueue(json);
    }

    private sealed class FakeOutput : ITaskOutput
    {
        public TaskReading? Reading { get; set; }
        public TaskReading? Read(string session, string taskId) => session == Session && taskId == TaskId ? Reading : null;
    }

    private sealed class FakeProcesses : ITaskProcesses
    {
        public TaskProcess? Find(int terminalPid, DateTime startedAt, IReadOnlySet<int> taken) => null;
        public bool Stop(TaskProcess process) => true;
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
    public void The_output_file_gives_its_last_line_and_exit_code()
    {
        var root = Path.Combine(Path.GetTempPath(), $"termilly-tasks-{Guid.NewGuid():N}");
        var folder = Path.Combine(root, "claude", "d4978", Session, "tasks");
        Directory.CreateDirectory(folder);
        try
        {
            var file = Path.Combine(folder, TaskId + ".output");
            File.WriteAllText(file, "line one\nline two\n");
            var reader = new ClaudeTaskOutput(root);
            Assert.Equal(new TaskReading(file, "line two", null), reader.Read(Session, TaskId));
            File.WriteAllText(file, "line one\nfinished-bg\n\n[exited with code 0]\n");
            Assert.Equal(new TaskReading(file, "finished-bg", 0), reader.Read(Session, TaskId));
            Assert.Null(reader.Read(Session, "other"));
        }
        finally
        {
            Directory.Delete(root, true);
        }
    }
}
