using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using Termilly.Shared;

namespace Termilly.Desktop.Features;

/// <summary>
/// The compact view's lines (js/compact.js): for each terminal whose view is on, its agent session's file, followed as
/// it grows. A view that's switched on gets every line so far, then only what's new or changed. A session whose file
/// isn't written yet (a new session, before its first prompt) is looked for again until it is.
/// </summary>
internal sealed class CompactFeed : IMessageHandler, IDisposable
{
    /// <summary>How often the followed files are read: a file that hasn't grown costs a size check.</summary>
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(500);
    /// <summary>A file not written yet is looked for every this many reads (a search of the agent's folders).</summary>
    private const int FindEvery = 4;
    /// <summary>A line longer than this (a huge tool result) is passed over; its tool keeps "running".</summary>
    private const int MaxLine = 16 << 20;

    private readonly Action<ToPage.CompactLines> _post;
    private readonly Func<string, string, string?> _find;
    private readonly Dictionary<string, Follow> _panes = new(StringComparer.Ordinal);
    private readonly Lock _lock = new();
    private readonly Timer _timer;
    private int _ticking;

    public CompactFeed(PageChannel page)
        : this(page.Post, FindFile)
    {
    }

    /// <param name="post">Sends the page its lines.</param>
    /// <param name="find">The file of a session (its id, its agent's kind); null while there's none.</param>
    internal CompactFeed(Action<ToPage.CompactLines> post, Func<string, string, string?> find)
    {
        (_post, _find) = (post, find);
        _timer = new Timer(_ => Tick(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);
    }

    public void Register(MessageRouter router) => router.On<FromPage.CompactWatch>(Watch);

    /// <summary>A terminal's view switched on (or to a new session), or off (no session).</summary>
    public void Watch(FromPage.CompactWatch m)
    {
        lock (_lock)
        {
            if (string.IsNullOrEmpty(m.Session))
            {
                _panes.Remove(m.Id);
            }
            else if (_panes.TryGetValue(m.Id, out var known) && known.Session == m.Session)
            {
                known.AskForAll(); // the view came back: it gets every line again
            }
            else
            {
                _panes[m.Id] = new Follow(m.Session, m.Agent == AgentKinds.Codex ? AgentKinds.Codex : AgentKinds.Claude);
            }
            _timer.Change(_panes.Count == 0 ? Timeout.InfiniteTimeSpan : TimeSpan.Zero, _panes.Count == 0 ? Timeout.InfiniteTimeSpan : Interval);
        }
    }

    /// <summary>Reads every followed file once and sends what changed (the timer's work; tests call it directly).</summary>
    public void Tick()
    {
        if (Interlocked.Exchange(ref _ticking, 1) == 1)
        {
            return;
        }
        try
        {
            List<(string Pane, Follow Follow)> panes;
            lock (_lock)
            {
                panes = _panes.Select(p => (p.Key, p.Value)).ToList();
            }
            foreach (var (pane, follow) in panes)
            {
                if (Read(follow) is { } message && Still(pane, follow))
                {
                    _post(message with { Id = pane });
                }
            }
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    /// <summary>Whether the terminal still follows this session (it may have switched off while its file was read).</summary>
    private bool Still(string pane, Follow follow)
    {
        lock (_lock)
        {
            return _panes.GetValueOrDefault(pane) == follow;
        }
    }

    /// <summary>What a session's view needs now: every line (it was switched on), what changed, or nothing.</summary>
    private ToPage.CompactLines? Read(Follow follow)
    {
        if (follow.Tail is null && follow.Misses++ % FindEvery == 0 && _find(follow.Session, follow.Agent) is { } path)
        {
            follow.Tail = new TranscriptTail(path, MaxLine);
        }
        if (follow.Tail is null)
        {
            return follow.TakeSendAll() ? new ToPage.CompactLines("", follow.Session, [], Reset: true) : null;
        }
        follow.Tail.Read(line =>
        {
            follow.Reader.Read(line, follow.Log);
            return true;
        });
        if (follow.TakeSendAll())
        {
            follow.Log.ClearChanged();
            return new ToPage.CompactLines("", follow.Session, follow.Log.All(), Reset: true);
        }
        var changed = follow.Log.TakeChanged();
        return changed.Count == 0 ? null : new ToPage.CompactLines("", follow.Session, changed, Reset: false);
    }

    /// <summary>A session's file: Claude Code's transcript, or Codex's rollout.</summary>
    private static string? FindFile(string session, string agent) => agent == AgentKinds.Codex
        ? UsageTracker.FindFile(CodexFiles.SessionsDirectory(), session, $"rollout-*-{session}.jsonl")
        : UsageTracker.FindTranscript(UsageTracker.ProjectsDirectory(), session);

    public void Dispose() => _timer.Dispose();

    /// <summary>One followed session: its file (once found), what was read of it, and whether the view needs it all.</summary>
    private sealed class Follow(string session, string agent)
    {
        public string Session { get; } = session;
        public string Agent { get; } = agent;
        public ICompactReader Reader { get; } = agent == AgentKinds.Codex ? new CompactCodex() : new CompactClaude();
        public CompactLog Log { get; } = new();
        public TranscriptTail? Tail { get; set; }
        public int Misses { get; set; }
        /// <summary>1 while the view needs every line (it was just switched on), even none, so it can say so.</summary>
        private int _sendAll = 1;

        public void AskForAll() => Volatile.Write(ref _sendAll, 1);

        public bool TakeSendAll() => Interlocked.Exchange(ref _sendAll, 0) == 1;
    }
}
