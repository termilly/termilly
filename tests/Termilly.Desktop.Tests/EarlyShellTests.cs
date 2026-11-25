using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>A shell started before the page was up: its resume command, its answers, and the page taking it over.</summary>
public sealed class EarlyShellTests
{
    private const string Command = "claude --resume 0f8e2c1a-1111-2222-3333-444455556666";
    private const string VersionReply = "\u001bP>|Termilly 9.9.9\u001b\\";
    private static readonly TimeSpan Wait = TimeSpan.FromSeconds(5);

    /// <summary>A shell that keeps what's typed into it.</summary>
    private sealed class FakeShell : IShellSession
    {
        private readonly List<string> _typed = [];
        public int ProcessId => 1;
        public IReadOnlyList<string> Typed { get { lock (_typed) { return [.. _typed]; } } }
        public void Write(string text) { lock (_typed) { _typed.Add(text); } }
        public void Resize(int columns, int rows) { }
        public void Dispose() { }
    }

    private static (EarlyShell Early, FakeShell Shell) Started()
    {
        var shell = new FakeShell();
        return (new EarlyShell(Command, VersionReply) { Session = shell }, shell);
    }

    private static void WaitFor(Func<bool> done)
    {
        var until = DateTime.UtcNow + Wait;
        while (!done() && DateTime.UtcNow < until)
        {
            Thread.Sleep(10);
        }
    }

    [Fact]
    public void The_command_is_typed_once_at_the_first_prompt()
    {
        var (early, shell) = Started();
        early.Print("Windows PowerShell\r\n");
        Assert.Empty(shell.Typed);
        early.Print("\u001b]133;A\u0007PS C:\\> \u001b]133;B\u0007");
        early.Print("\u001b]133;A\u0007PS C:\\> \u001b]133;B\u0007");
        WaitFor(() => shell.Typed.Count > 0);
        Thread.Sleep(PromptTiming.AtPromptMs * 2);
        Assert.Equal([$"{Command}\r"], shell.Typed);
    }

    [Fact]
    public void A_mark_split_between_two_chunks_is_seen()
    {
        var (early, shell) = Started();
        early.Print("PS> \u001b]13");
        early.Print("3;B\u0007");
        WaitFor(() => shell.Typed.Count > 0);
        Assert.Equal([$"{Command}\r"], shell.Typed);
    }

    [Fact]
    public void The_version_query_is_answered_until_the_page_takes_over()
    {
        var (early, shell) = Started();
        early.Print("\u001b[>0q");
        Assert.Contains(VersionReply, shell.Typed);
        early.Take(_ => { }, _ => { }, _ => { });
        early.Print("\u001b[>0q");
        Assert.Single(shell.Typed, VersionReply);
    }

    [Fact]
    public void What_it_printed_is_replayed_first_then_the_rest_goes_live()
    {
        var (early, _) = Started();
        early.Print("one ");
        early.Print("two ");
        var replayed = new List<string>();
        var live = new List<string>();
        early.Take(live.Add, replayed.Add, _ => { });
        early.Print("three");
        Assert.Equal(["one two "], replayed);
        Assert.Equal(["three"], live);
    }

    [Fact]
    public void An_agent_report_before_the_page_takes_over_is_told_after_the_replay()
    {
        var (early, _) = Started();
        var heard = new List<string>();
        Assert.True(early.Keep(() => heard.Add("SessionStart")));
        early.Take(_ => heard.Add("live"), _ => heard.Add("replay"), _ => { });
        Assert.False(early.Keep(() => heard.Add("late")));
        Assert.Equal(["SessionStart"], heard);
    }

    [Fact]
    public void An_exit_before_the_page_takes_over_is_told_after_the_replay()
    {
        var (early, _) = Started();
        early.Print("No conversation found");
        early.Exited(1);
        var heard = new List<string>();
        early.Take(_ => heard.Add("live"), _ => heard.Add("replay"), code => heard.Add($"exit {code}"));
        Assert.Equal(["replay", "exit 1"], heard);
    }
}
