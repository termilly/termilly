using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop;

/// <summary>
/// When a Codex command run on in the background ends: its rollout file (the session's log) gets an item_completed
/// line for it, named by the same id its hooks gave it, with its exit code and output. Codex writes nothing before,
/// so a running one reads as null. Each session's file is followed as it grows, read from its start once.
/// </summary>
internal sealed class CodexTaskOutput : ITaskOutput
{
    /// <summary>A rollout line longer than this (a command's huge output) is skipped.</summary>
    private const int MaxLine = 16 << 20;
    /// <summary>The exit code of a command with none given, as Codex writes it for one it stopped.</summary>
    private const int StoppedExit = -1;
    private static readonly byte[] Mark = Encoding.UTF8.GetBytes(Fields.CommandExecution);

    private readonly string _sessions;
    private readonly Dictionary<string, Follow> _follows = [];

    public CodexTaskOutput()
        : this(CodexFiles.SessionsDirectory())
    {
    }

    /// <param name="sessions">The folder Codex's rollout files are in (a test's own).</param>
    internal CodexTaskOutput(string sessions) => _sessions = sessions;

    public bool ReadsWhileRunning => false;

    private sealed class Follow
    {
        public TranscriptTail? Tail { get; set; }
        public Dictionary<string, TaskReading> Ended { get; } = [];
    }

    private static class Fields
    {
        public const string Payload = "payload";
        public const string Type = "type";
        public const string Item = "item";
        public const string ItemCompleted = "item_completed";
        public const string CommandExecution = "CommandExecution";
        public const string Id = "id";
        public const string ExitCode = "exit_code";
        public const string Output = "aggregated_output";
    }

    public TaskReading? Read(string session, string taskId)
    {
        if (!_follows.TryGetValue(session, out var follow))
        {
            _follows[session] = follow = new Follow();
        }
        if (follow.Tail is null && UsageTracker.FindFile(_sessions, session, $"rollout-*-{session}.jsonl") is { } path)
        {
            follow.Tail = new TranscriptTail(path, MaxLine);
        }
        follow.Tail?.Read(line => Ended(line, follow.Ended));
        return follow.Ended.GetValueOrDefault(taskId);
    }

    public void Forget(string session) => _follows.Remove(session);

    /// <summary>A command's end, kept by its id; only lines that name a command are parsed.</summary>
    private static bool Ended(ReadOnlySpan<byte> line, Dictionary<string, TaskReading> ended)
    {
        if (line.IndexOf(Mark) < 0)
        {
            return false;
        }
        try
        {
            var payload = JsonNode.Parse(line)?[Fields.Payload];
            if (payload?[Fields.Type].AsText() != Fields.ItemCompleted
                || payload[Fields.Item] is not JsonObject item || item[Fields.Type].AsText() != Fields.CommandExecution
                || item[Fields.Id].AsText() is not { } id)
            {
                return false;
            }
            // One Codex stopped (or that was stopped) has none.
            var exit = item[Fields.ExitCode].AsInt() ?? StoppedExit;
            var last = item[Fields.Output].AsText()?.Split('\n').Select(l => l.Trim()).LastOrDefault(l => l.Length > 0);
            ended[id] = new TaskReading(null, last, exit);
            return true;
        }
        catch (JsonException)
        {
            return false;
        }
    }
}
