using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class ClaudeUsageTests : IDisposable
{
    private const string Session = "0b5d4b9e-1c2a-4d6e-9f00-123456789abc";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-usage-" + Guid.NewGuid().ToString("N"));

    public ClaudeUsageTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static string Reply(string id, int input, int write, int read, int output, string requested = "claude-opus-5-5", bool side = false) =>
        $$"""{"type":"assistant","isSidechain":{{(side ? "true" : "false")}},"requestedModel":"{{requested}}","version":"2.1.296","gitBranch":"main","timestamp":"2026-10-11T10:00:00Z","message":{"id":"{{id}}","model":"claude-opus-5-5","content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":{{input}},"cache_creation_input_tokens":{{write}},"cache_read_input_tokens":{{read}},"output_tokens":{{output}}""" + "}}}";

    private const string Prompt = """{"type":"user","timestamp":"2026-10-11T09:59:00Z","message":{"role":"user","content":"rename the variables"}}""";

    private string Transcript(params string[] lines)
    {
        var path = Path.Combine(_dir, Session + ".jsonl");
        File.WriteAllText(path, string.Join("\n", lines) + "\n");
        return path;
    }

    [Fact]
    public void A_reply_written_as_several_lines_counts_once()
    {
        var reader = new TranscriptUsage(Transcript(Prompt, Reply("m1", 10, 100, 1000, 50), Reply("m1", 10, 100, 1000, 50), Reply("m2", 2, 20, 1100, 30)), Session);
        Assert.True(reader.Read());
        var u = reader.Usage;
        Assert.Equal((12L, 120L, 2100L, 80L, 2), (u.Input, u.CacheWrite, u.CacheRead, u.Output, u.Replies));
        Assert.Equal(2 + 20 + 1100, u.Context); // output isn't part of the context, as in Claude Code's own figure
        Assert.Equal(("claude-opus-5-5", 200_000L, "2.1.296"), (u.Model, u.ContextWindow, u.Version));
        Assert.Null(u.Branch); // its gitBranch "main" isn't taken: the branch is read from the repo Claude works in
        Assert.Equal(DateTimeOffset.Parse("2026-10-11T09:59:00Z", System.Globalization.CultureInfo.InvariantCulture), u.Started);
    }

    [Fact]
    public void A_1m_model_has_the_larger_context_window() =>
        Assert.Equal(1_000_000, Read(Reply("m1", 1, 1, 1, 1, "claude-opus-5-5[1m]")).ContextWindow);

    [Fact]
    public void Subagent_replies_are_left_out() =>
        Assert.Equal(5, Read(Reply("m1", 1, 1, 1, 5), Reply("m2", 1, 1, 1, 500, side: true)).Output);

    [Fact]
    public void Compacting_empties_the_context_until_the_next_reply()
    {
        var u = Read(Reply("m1", 1, 1, 150_000, 5), """{"type":"system","subtype":"compact_boundary","timestamp":"2026-10-11T10:05:00Z"}""");
        Assert.Equal((0L, 1), (u.Context, u.Compactions));
    }

    [Fact]
    public void Only_what_was_added_is_read_and_a_half_written_line_waits()
    {
        var path = Transcript(Reply("m1", 1, 1, 1, 5));
        var reader = new TranscriptUsage(path, Session);
        Assert.True(reader.Read());
        Assert.False(reader.Read()); // nothing new

        var next = Reply("m2", 1, 1, 1, 7);
        File.AppendAllText(path, next[..40]);
        Assert.False(reader.Read());
        Assert.Equal(5, reader.Usage.Output);
        File.AppendAllText(path, next[40..] + "\n");
        Assert.True(reader.Read());
        Assert.Equal(12, reader.Usage.Output);
    }

    [Fact]
    public void The_tracker_finds_the_transcript_in_its_project_folder_and_reports_it()
    {
        var project = Directory.CreateDirectory(Path.Combine(_dir, "D--work-app")).FullName;
        File.WriteAllText(Path.Combine(project, Session + ".jsonl"), Reply("m1", 1, 1, 1, 9) + "\n");
        var reports = new List<(string Pane, ClaudeUsage Usage)>();
        using var tracker = new ClaudeUsageTracker((pane, usage) => { lock (reports) { reports.Add((pane, usage)); } }, _dir);

        tracker.Track("t1", "../escape");
        tracker.Track("t1", Session);
        tracker.Tick();
        // Track reads in the background too, and a Tick meanwhile leaves it to that one: the report follows shortly.
        bool Reported()
        {
            lock (reports)
            {
                return reports.Any(r => r.Pane == "t1" && r.Usage.Output == 9 && r.Usage.Session == Session);
            }
        }
        Assert.True(SpinWait.SpinUntil(Reported, TimeSpan.FromSeconds(5)));
    }

    // ---- The branch, from the repo Claude works in ----

    private string Folder(string name) => Directory.CreateDirectory(Path.Combine(_dir, name)).FullName;

    [Fact]
    public void A_folder_outside_a_repo_has_no_branch() =>
        Assert.Null(GitBranch.Of(Folder("plain/sub"), ceiling: _dir));

    [Fact]
    public void A_folder_in_a_repo_has_its_branch_and_a_detached_head_says_so()
    {
        var repo = Folder("repo");
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        File.WriteAllText(Path.Combine(repo, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
        Assert.Equal("feature/x", GitBranch.Of(Folder("repo/src/deep"), ceiling: _dir));

        File.WriteAllText(Path.Combine(repo, ".git", "HEAD"), "1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b\n");
        Assert.Equal("detached @1a2b3c4", GitBranch.Of(repo, ceiling: _dir));
    }

    [Fact]
    public void A_worktree_has_its_own_branch()
    {
        var gitDir = Folder("main/.git/worktrees/wt");
        File.WriteAllText(Path.Combine(gitDir, "HEAD"), "ref: refs/heads/agent-1\n");
        var worktree = Folder("wt");
        File.WriteAllText(Path.Combine(worktree, ".git"), "gitdir: ../main/.git/worktrees/wt\n");
        Assert.Equal("agent-1", GitBranch.Of(worktree, ceiling: _dir));
    }

    [Fact]
    public void The_branch_follows_the_folder_claude_works_in()
    {
        var repo = Folder("app");
        Directory.CreateDirectory(Path.Combine(repo, ".git"));
        File.WriteAllText(Path.Combine(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
        var cwd = System.Text.Json.JsonSerializer.Serialize(repo);
        var line = Reply("m1", 1, 1, 1, 1).Replace("\"gitBranch\":\"main\"", $"\"gitBranch\":\"HEAD\",\"cwd\":{cwd}");
        Assert.Equal("main", Read(line).Branch);
    }

    private ClaudeUsage Read(params string[] lines)
    {
        var reader = new TranscriptUsage(Transcript(lines), Session);
        reader.Read();
        return reader.Usage;
    }
}
