using System.Buffers;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// A Claude Code session's token use so far, from its transcript. <see cref="Context"/> is what the last reply took
/// in and wrote (how full the context is), out of <see cref="ContextWindow"/>; the totals add up every reply.
/// </summary>
internal sealed record ClaudeUsage(
    string Session, string? Model, long ContextWindow, long Context,
    long Input, long CacheWrite, long CacheRead, long Output, int Replies, int Compactions,
    string? Version, string? Branch, DateTimeOffset? Started, DateTimeOffset? Last)
{
    /// <summary>What these tokens would cost on the API (Pricing.cs); null for a model not in its table.</summary>
    public double? EstimatedUsd => Pricing.Estimate(Model, Input, CacheWrite, CacheRead, Output);
}

/// <summary>
/// Reads the token use out of one Claude Code transcript (~/.claude/projects/&lt;folder&gt;/&lt;session&gt;.jsonl),
/// a little at a time: each <see cref="Read"/> takes only what was written since the last. Only the usage, model and
/// a few session details are kept; prompts, replies and tool output are skipped without being decoded.
/// </summary>
internal sealed class TranscriptUsage
{
    private const int Chunk = 1 << 20;
    /// <summary>A line this long is a tool result or a file, never a reply's usage: skipped unread.</summary>
    private const int MaxLine = 4 << 20;

    private const string Assistant = "assistant";
    private const string CompactBoundary = "compact_boundary";
    /// <summary>In the requested model's name, the 1M-token context ("claude-opus-5-5[1m]").</summary>
    private const string LongContextMark = "[1m]";
    private const long DefaultContextWindow = 200_000;
    private const long LongContextWindow = 1_000_000;

    private static readonly byte[] AssistantMark = "\"type\":\"assistant\""u8.ToArray();
    private static readonly byte[] CompactMark = "\"compact_boundary\""u8.ToArray();

    private readonly string _session;
    // One reply is written as several lines (one per content block), each with the reply's usage: the last one counts.
    private readonly Dictionary<string, Tokens> _replies = new();
    private readonly ArrayBufferWriter<byte> _pending = new();
    private long _offset;
    private bool _skipping;
    private string? _model;
    private long _window = DefaultContextWindow;
    private long _context;
    private Tokens _total;
    private int _compactions;
    private string? _version;
    /// <summary>The folder Claude works in (its latest); the branch is read from the repo there, if it is one.</summary>
    private string? _cwd;
    private DateTimeOffset? _started;
    private DateTimeOffset? _last;

    /// <param name="sidechain">A subagent's own transcript, whose replies are all sidechain lines (which a session's
    /// transcript skips: they're its subagents').</param>
    public TranscriptUsage(string path, string session, bool sidechain = false)
    {
        Path = path;
        _session = session;
        _sidechain = sidechain;
    }

    private readonly bool _sidechain;

    public string Path { get; }

    public ClaudeUsage Usage => new(_session, _model, _window, _context, _total.In, _total.Write, _total.Read, _total.Out,
        _replies.Count, _compactions, _version, GitBranch.Of(_cwd), _started, _last);

    /// <summary>Reads what was added since the last call; true when the usage changed.</summary>
    public bool Read()
    {
        FileStream file;
        try
        {
            file = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return false;
        }
        using (file)
        {
            if (file.Length <= _offset)
            {
                return false; // nothing new, or rewritten under us (keep what we have)
            }
            file.Seek(_offset, SeekOrigin.Begin);
            var changed = false;
            var buffer = new byte[Chunk];
            int read;
            while ((read = file.Read(buffer, 0, buffer.Length)) > 0)
            {
                changed |= Feed(buffer.AsSpan(0, read));
                _offset += read;
            }
            return changed;
        }
    }

    /// <summary>Splits what was read into lines (a line can span reads); true when one of them changed the usage.</summary>
    private bool Feed(ReadOnlySpan<byte> span)
    {
        var changed = false;
        while (span.Length > 0)
        {
            var end = span.IndexOf((byte)'\n');
            var part = end < 0 ? span : span[..end];
            if (!_skipping)
            {
                if (_pending.WrittenCount + part.Length > MaxLine)
                {
                    _skipping = true;
                    _pending.ResetWrittenCount();
                }
                else
                {
                    _pending.Write(part);
                }
            }
            if (end < 0)
            {
                break;
            }
            if (!_skipping)
            {
                changed |= Line(_pending.WrittenSpan);
            }
            _pending.ResetWrittenCount();
            _skipping = false;
            span = span[(end + 1)..];
        }
        return changed;
    }

    private bool Line(ReadOnlySpan<byte> line)
    {
        var assistant = line.IndexOf(AssistantMark) >= 0;
        if (!assistant && line.IndexOf(CompactMark) < 0 && _started is not null)
        {
            return false;
        }
        try
        {
            using var doc = JsonDocument.Parse(line.ToArray());
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return false;
            }
            if (Str(root, Fields.Timestamp) is { } stamp && DateTimeOffset.TryParse(stamp, out var at))
            {
                _started ??= at;
            }
            if (Str(root, Fields.Subtype) == CompactBoundary)
            {
                _compactions++;
                _context = 0;
                return true;
            }
            if (ReplyUsage(root) is not ({ } message, { } usage))
            {
                return false;
            }
            AddReply(root, message, usage);
            return true;
        }
        catch (JsonException)
        {
            return false; // a line still being written, or not JSON
        }
    }

    /// <summary>A reply's message and its usage; null for any other line (a subagent's, in a session's transcript).</summary>
    private (JsonElement Message, JsonElement Usage)? ReplyUsage(JsonElement root) =>
        Str(root, Fields.Type) == Assistant
        && (_sidechain || !root.TryGetProperty(Fields.IsSidechain, out var side) || side.ValueKind != JsonValueKind.True)
        && root.TryGetProperty(Fields.Message, out var message) && message.ValueKind == JsonValueKind.Object
        && message.TryGetProperty(Fields.Usage, out var usage) && usage.ValueKind == JsonValueKind.Object
            ? (message, usage)
            : null;

    private void AddReply(JsonElement root, JsonElement message, JsonElement usage)
    {
        var reply = new Tokens(Num(usage, Fields.InputTokens), Num(usage, Fields.CacheWriteTokens), Num(usage, Fields.CacheReadTokens), Num(usage, Fields.OutputTokens));
        var id = Str(message, Fields.Id) ?? Str(root, Fields.Uuid) ?? Guid.NewGuid().ToString();
        if (_replies.TryGetValue(id, out var before))
        {
            _total -= before;
        }
        _replies[id] = reply;
        _total += reply;
        // What the reply took in: Claude Code's own context figure counts input and cache, not the reply's output.
        _context = reply.In + reply.Write + reply.Read;
        if (Str(message, Fields.Model) is { } model && !model.StartsWith('<'))
        {
            _model = model;
        }
        // The model as asked for says whether it has the 1M-token context ("claude-opus-5-5[1m]").
        if (Str(root, Fields.RequestedModel) is { } requested)
        {
            _window = requested.Contains(LongContextMark, StringComparison.OrdinalIgnoreCase) ? LongContextWindow : DefaultContextWindow;
        }
        _window = Math.Max(_window, _context); // a window we guessed too small
        _version = Str(root, Fields.Version) ?? _version;
        // Not the transcript's gitBranch: Claude Code writes "HEAD" for a folder that isn't a repo.
        _cwd = Str(root, Fields.Cwd) ?? _cwd;
        if (Str(root, Fields.Timestamp) is { } when && DateTimeOffset.TryParse(when, out var last))
        {
            _last = last;
        }
    }

    /// <summary>One reply's tokens, or the session's totals.</summary>
    private readonly record struct Tokens(long In, long Write, long Read, long Out)
    {
        public static Tokens operator +(Tokens a, Tokens b) => new(a.In + b.In, a.Write + b.Write, a.Read + b.Read, a.Out + b.Out);
        public static Tokens operator -(Tokens a, Tokens b) => new(a.In - b.In, a.Write - b.Write, a.Read - b.Read, a.Out - b.Out);
    }

    /// <summary>The transcript fields read.</summary>
    private static class Fields
    {
        public const string Timestamp = "timestamp";
        public const string Subtype = "subtype";
        public const string Type = "type";
        public const string IsSidechain = "isSidechain";
        public const string Message = "message";
        public const string Usage = "usage";
        public const string Id = "id";
        public const string Uuid = "uuid";
        public const string Model = "model";
        public const string RequestedModel = "requestedModel";
        public const string Version = "version";
        public const string Cwd = "cwd";
        public const string InputTokens = "input_tokens";
        public const string CacheWriteTokens = "cache_creation_input_tokens";
        public const string CacheReadTokens = "cache_read_input_tokens";
        public const string OutputTokens = "output_tokens";
    }

    private static string? Str(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static long Num(JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt64(out var n) ? n : 0;
}

/// <summary>
/// Follows the Claude Code session in each terminal (from its hooks, or the `claude agents` fallback) and reports
/// its token use as it grows. Every two seconds it looks at the transcripts of the sessions it follows; one that
/// hasn't grown costs a file-size check.
/// </summary>
internal sealed partial class ClaudeUsageTracker : IDisposable
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(2);

    private readonly Action<string, ClaudeUsage> _changed;
    private readonly string _projects;
    private readonly Dictionary<string, (string Session, TranscriptUsage? Reader)> _panes = new();
    private readonly Lock _lock = new();
    private readonly Timer _timer;
    private int _ticking;

    /// <param name="changed">Called on a pool thread with a terminal's id and its session's usage.</param>
    /// <param name="projects">Claude Code's projects folder; by default ~/.claude/projects (or under CLAUDE_CONFIG_DIR).</param>
    public ClaudeUsageTracker(Action<string, ClaudeUsage> changed, string? projects = null)
    {
        _changed = changed;
        _projects = projects ?? ProjectsDirectory();
        _timer = new Timer(_ => Tick(), null, Interval, Interval);
    }

    public static string ProjectsDirectory() => System.IO.Path.Combine(ClaudeCodeFiles.ConfigDirectory(), ClaudeCodeFiles.Projects);

    /// <summary>The terminal runs this session now (null or a new one starts over); its usage follows shortly.</summary>
    public void Track(string pane, string? session)
    {
        if (session is null || !SessionId().IsMatch(session))
        {
            return;
        }
        lock (_lock)
        {
            if (_panes.TryGetValue(pane, out var known) && known.Session == session)
            {
                return;
            }
            _panes[pane] = (session, null);
        }
        ThreadPool.QueueUserWorkItem(_ => Tick());
    }

    /// <summary>The terminal's session ended, or the terminal closed.</summary>
    public void Forget(string pane)
    {
        lock (_lock)
        {
            _panes.Remove(pane);
        }
    }

    /// <summary>The transcript of a session, in whichever project folder Claude Code put it.</summary>
    public string? FindTranscript(string session)
    {
        try
        {
            return Directory.Exists(_projects)
                ? Directory.EnumerateFiles(_projects, session + ".jsonl", SearchOption.AllDirectories).FirstOrDefault()
                : null;
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null;
        }
    }

    /// <summary>Reads every followed transcript once (the timer's work; tests call it directly).</summary>
    public void Tick()
    {
        if (Interlocked.Exchange(ref _ticking, 1) == 1)
        {
            return;
        }
        try
        {
            List<(string Pane, string Session, TranscriptUsage? Reader)> panes;
            lock (_lock)
            {
                panes = _panes.Select(p => (p.Key, p.Value.Session, p.Value.Reader)).ToList();
            }
            foreach (var (pane, session, known) in panes)
            {
                var reader = known;
                if (reader is null)
                {
                    if (FindTranscript(session) is not { } path)
                    {
                        continue; // not written yet: Claude Code starts it with the first prompt
                    }
                    reader = new TranscriptUsage(path, session);
                    lock (_lock)
                    {
                        if (!_panes.TryGetValue(pane, out var now) || now.Session != session)
                        {
                            continue;
                        }
                        _panes[pane] = (session, reader);
                    }
                }
                if (reader.Read())
                {
                    _changed(pane, reader.Usage);
                }
            }
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    public void Dispose() => _timer.Dispose();

    // Session ids are GUIDs; anything else isn't looked up (it becomes part of a file pattern).
    [GeneratedRegex(@"^[A-Za-z0-9-]{8,64}$")]
    private static partial Regex SessionId();
}

/// <summary>
/// The Claude plan the user is signed in with ("pro", "max", "team"...), from `claude auth status`. Only that and how
/// they sign in are read; the e-mail and organization it also prints are not kept.
/// </summary>
internal sealed class ClaudePlan(IProcessRunner runner)
{
    /// <summary>How long `claude auth status` may take.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(15);

    public sealed record Info(string? Subscription, string? AuthMethod);

    public async Task<Info?> ReadAsync(string claude)
    {
        try
        {
            var result = await runner.RunAsync(new ProcessRequest(claude, ["auth", "status"]) { Timeout = Timeout }).ConfigureAwait(false);
            return Parse(result.Text);
        }
        catch (IOException)
        {
            return null;
        }
    }

    /// <summary>The longest plan or sign-in name taken from `claude auth status`.</summary>
    private const int MaxPlanText = 40;

    public static Info? Parse(string? json)
    {
        try
        {
            using var doc = JsonDocument.Parse(json ?? "");
            var root = doc.RootElement;
            if (root.ValueKind != JsonValueKind.Object)
            {
                return null;
            }
            static string? Str(JsonElement e, string name) =>
                e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String && v.GetString() is { Length: > 0 and <= MaxPlanText } s ? s : null;
            return new Info(Str(root, "subscriptionType"), Str(root, "authMethod"));
        }
        catch (JsonException)
        {
            return null;
        }
    }
}

/// <summary>
/// The git branch of the repo a folder is in, read from the repo's files (no git process): null when the folder
/// isn't in a repo, "detached @1a2b3c4" on a detached HEAD.
/// </summary>
internal static class GitBranch
{
    /// <summary>A worktree's or submodule's .git file: "gitdir: &lt;path&gt;".</summary>
    private const string GitDirMark = "gitdir:";
    /// <summary>How much of a detached HEAD's hash is shown, as git's short hashes are.</summary>
    private const int ShortHash = 7;

    /// <param name="ceiling">A folder the search doesn't go above (tests; like GIT_CEILING_DIRECTORIES).</param>
    public static string? Of(string? folder, string? ceiling = null)
    {
        if (string.IsNullOrWhiteSpace(folder))
        {
            return null;
        }
        try
        {
            for (var dir = new DirectoryInfo(folder); dir is not null; dir = dir.Parent)
            {
                var dotGit = System.IO.Path.Combine(dir.FullName, GitCommands.DotGit);
                string? gitDir = null;
                if (Directory.Exists(dotGit))
                {
                    gitDir = dotGit;
                }
                else if (File.Exists(dotGit))
                {
                    // A worktree or submodule: "gitdir: <path>", relative to the folder holding the file.
                    var line = File.ReadLines(dotGit).FirstOrDefault() ?? "";
                    if (line.StartsWith(GitDirMark, StringComparison.Ordinal))
                    {
                        gitDir = System.IO.Path.GetFullPath(System.IO.Path.Combine(dir.FullName, line[GitDirMark.Length..].Trim()));
                    }
                }
                if (gitDir is null && ceiling is not null && string.Equals(dir.FullName.TrimEnd('\\'), System.IO.Path.GetFullPath(ceiling).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase))
                {
                    return null;
                }
                if (gitDir is null)
                {
                    continue;
                }
                var head = System.IO.Path.Combine(gitDir, GitCommands.Head);
                if (!File.Exists(head))
                {
                    return null;
                }
                var text = File.ReadAllText(head).Trim();
                const string Ref = "ref: refs/heads/";
                return text.StartsWith(Ref, StringComparison.Ordinal) ? text[Ref.Length..]
                    : text.Length >= ShortHash && text.All(Uri.IsHexDigit) ? $"detached @{text[..ShortHash]}"
                    : null;
            }
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or NotSupportedException)
        {
        }
        return null;
    }
}
