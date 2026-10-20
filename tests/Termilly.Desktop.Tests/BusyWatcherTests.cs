namespace Termilly.Desktop.Tests;

public sealed class BusyWatcherTests
{
    // A terminal whose pseudo console started pwsh.exe (pid 100); 1 is an unrelated parent.
    private static List<ProcessEntry> Tree(params ProcessEntry[] extra) =>
    [
        new(1, 0, "explorer.exe"),
        new(100, 1, "pwsh.exe"),
        new(101, 100, "conhost.exe"),
        .. extra,
    ];

    [Fact]
    public void A_shell_at_its_prompt_is_idle() =>
        Assert.Null(BusyWatcher.BusyChild(Tree(), 100));

    [Fact]
    public void A_child_process_is_the_command_running() =>
        Assert.Equal("notepad.exe", BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 100, "notepad.exe")), 100));

    [Fact]
    public void A_command_inside_a_nested_shell_counts_but_the_nested_shell_alone_does_not()
    {
        Assert.Null(BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 100, "cmd.exe")), 100));
        Assert.Equal("PING.EXE", BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 100, "cmd.exe"), new ProcessEntry(300, 200, "PING.EXE")), 100));
    }

    [Theory]
    [InlineData("ssh.exe")]
    [InlineData("vim.exe")]
    [InlineData("claude.exe")]
    [InlineData("wsl.exe")]
    [InlineData("LESS.EXE")]
    public void Interactive_programs_and_what_they_start_are_ignored(string program) =>
        Assert.Null(BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 100, program), new ProcessEntry(300, 200, "helper.exe")), 100));

    [Fact]
    public void Only_the_terminals_own_descendants_count() =>
        Assert.Null(BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 1, "notepad.exe")), 100));

    [Fact]
    public void The_root_itself_is_never_the_busy_program()
    {
        // A profile whose command is ssh: the root is ssh.exe with no children.
        List<ProcessEntry> tree = [new(1, 0, "explorer.exe"), new(100, 1, "ssh.exe"), new(101, 100, "conhost.exe")];
        Assert.Null(BusyWatcher.BusyChild(tree, 100));
    }

    [Fact]
    public void A_parent_id_loop_from_reused_ids_ends_and_never_counts_the_root() =>
        // Windows reuses ids: here an entry claiming the root's id hangs under the nested shell.
        Assert.Null(BusyWatcher.BusyChild(Tree(new ProcessEntry(200, 100, "cmd.exe"), new ProcessEntry(100, 200, "a.exe")), 100));

    [Fact]
    public void An_interactive_program_is_reported_as_such_but_a_command_wins()
    {
        Assert.Equal(new ChildProgram("ssh.exe", Interactive: true), BusyWatcher.Running(Tree(new ProcessEntry(200, 100, "ssh.exe")), 100));
        Assert.Equal(new ChildProgram("PING.EXE", Interactive: false),
            BusyWatcher.Running(Tree(new ProcessEntry(200, 100, "vim.exe"), new ProcessEntry(300, 100, "PING.EXE")), 100));
        Assert.Null(BusyWatcher.Running(Tree(), 100));
    }

    [Fact]
    public void A_wsl_terminal_is_not_an_interactive_program_running_in_itself()
    {
        // wsl.exe (the terminal) → wsl.exe → wslhost.exe → conhost.exe; Linux processes don't show on Windows.
        List<ProcessEntry> wsl = [new(1, 0, "explorer.exe"), new(100, 1, "wsl.exe"), new(200, 100, "wsl.exe"), new(300, 200, "wslhost.exe"), new(400, 300, "conhost.exe")];
        Assert.Null(BusyWatcher.Running(wsl, 100));
        Assert.Equal(new ChildProgram("ssh.exe", true), BusyWatcher.Running([.. wsl, new(500, 200, "ssh.exe")], 100));
    }
}
