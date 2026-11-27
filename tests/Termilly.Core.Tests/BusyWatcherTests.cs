using System.Diagnostics;
using System.Runtime.Versioning;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The activity spinner on Linux and macOS: what a terminal's shell runs, from /proc or sysctl.</summary>
public sealed class BusyWatcherTests
{
    [Fact]
    public void The_snapshot_has_a_running_command_under_its_parent()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        using var sleep = Process.Start("sleep", "5");
        try
        {
            var entry = Find(BusyWatcher.Snapshot(), sleep.Id);
            Assert.Equal("sleep", entry.Exe);
            Assert.Equal(Environment.ProcessId, entry.ParentId);
        }
        finally
        {
            sleep.Kill();
        }
    }

    [SupportedOSPlatform("linux")]
    [SupportedOSPlatform("macos")]
    private static ProcessEntry Find(List<ProcessEntry> all, int id) => Assert.Single(all, p => p.Id == id);

    [Fact]
    public void A_command_under_the_shell_is_busy_and_an_editor_is_not()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        ProcessEntry[] building = [new(10, 1, "bash"), new(11, 10, "make"), new(12, 11, "cc1")];
        Assert.Equal(new ChildProgram("make", Interactive: false), BusyWatcher.Running(building, 10));

        ProcessEntry[] editing = [new(10, 1, "bash"), new(11, 10, "vim")];
        Assert.Equal(new ChildProgram("vim", Interactive: true), BusyWatcher.Running(editing, 10));

        // A shell started from the terminal's shell (zsh typed at bash's prompt) waits for the user at its own prompt;
        // a command it runs is busy. pwsh marks its own commands (it gets Termilly's integration there too).
        ProcessEntry[] nested = [new(10, 1, "bash"), new(11, 10, "zsh")];
        Assert.Equal(new ChildProgram("zsh", Interactive: true), BusyWatcher.Running(nested, 10));
        Assert.Null(BusyWatcher.Running([new(10, 1, "bash"), new(11, 10, "pwsh")], 10));
        ProcessEntry[] nestedBusy = [new(10, 1, "bash"), new(11, 10, "zsh"), new(12, 11, "npm install")];
        Assert.Equal("npm install", BusyWatcher.BusyChild(nestedBusy, 10));
    }

    [Fact]
    public void A_terminal_the_page_opens_late_hears_again_what_it_runs()
    {
        // An early agent's shell runs its agent before the page knows the terminal: that first report is missed.
        using var child = OperatingSystem.IsWindows()
            ? Process.Start(new ProcessStartInfo("ping", "-n 30 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false })!
            : Process.Start("sleep", "30");
        var reports = new System.Collections.Concurrent.ConcurrentQueue<ChildProgram?>();
        using var watcher = new BusyWatcher(() => new Dictionary<string, int> { ["t"] = Environment.ProcessId }, (_, program) => reports.Enqueue(program));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => reports.Count == 1, TimeSpan.FromSeconds(5)));
            watcher.Resend("t");
            Assert.True(SpinWait.SpinUntil(() => reports.Count == 2, TimeSpan.FromSeconds(5)));
            Assert.Equal(reports.First(), reports.Last());
            Assert.NotNull(reports.Last());
        }
        finally
        {
            child.Kill();
        }
    }

    [Fact]
    public void A_terminal_whose_shell_was_replaced_never_hears_again_what_the_old_one_ran()
    {
        // The old shell ran a program (this process, with a child); the page reopens the terminal on a new shell, at
        // its prompt (a process with no children), and asks for it again.
        using var program = OperatingSystem.IsWindows()
            ? Process.Start(new ProcessStartInfo("ping", "-n 30 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false })!
            : Process.Start("sleep", "30");
        using var newShell = OperatingSystem.IsWindows()
            ? Process.Start(new ProcessStartInfo("ping", "-n 30 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false })!
            : Process.Start("sleep", "30");
        var root = Environment.ProcessId;
        var reports = new System.Collections.Concurrent.ConcurrentQueue<ChildProgram?>();
        using var watcher = new BusyWatcher(() => new Dictionary<string, int> { ["t"] = Volatile.Read(ref root) }, (_, p) => reports.Enqueue(p));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => reports.Count == 1, TimeSpan.FromSeconds(5)));
            Volatile.Write(ref root, newShell.Id);
            watcher.Resend("t");
            // What it runs now (nothing) goes out once it has lasted; the old program never again.
            Assert.True(SpinWait.SpinUntil(() => reports.Count == 2, TimeSpan.FromSeconds(5)));
            Thread.Sleep(1500);
            Assert.Equal(2, reports.Count);
            Assert.Null(reports.Last());
        }
        finally
        {
            program.Kill();
            newShell.Kill();
        }
    }

    [Fact]
    public void A_terminal_closed_before_its_first_state_counted_leaves_nothing_waiting()
    {
        // It runs something (this process, with a child) for one look, then it's gone; the page asks for it after.
        using var program = OperatingSystem.IsWindows()
            ? Process.Start(new ProcessStartInfo("ping", "-n 30 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false })!
            : Process.Start("sleep", "30");
        var looks = 0;
        var reports = new System.Collections.Concurrent.ConcurrentQueue<ChildProgram?>();
        using var watcher = new BusyWatcher(
            () => Interlocked.Increment(ref looks) == 1 ? new Dictionary<string, int> { ["a"] = Environment.ProcessId } : new Dictionary<string, int>(),
            (_, p) => reports.Enqueue(p));
        try
        {
            Assert.True(SpinWait.SpinUntil(() => Volatile.Read(ref looks) >= 2, TimeSpan.FromSeconds(5)));
            watcher.Resend("a");
            Assert.True(SpinWait.SpinUntil(() => !watcher.Waiting, TimeSpan.FromSeconds(5)));
            Assert.Empty(reports);
        }
        finally
        {
            program.Kill();
        }
    }

    [Fact]
    public void A_terminal_at_its_prompt_has_nothing_sent_again()
    {
        // Its shell runs nothing (a process with no children stands in for it): the page assumes the prompt already.
        using var shell = OperatingSystem.IsWindows()
            ? Process.Start(new ProcessStartInfo("ping", "-n 30 127.0.0.1") { CreateNoWindow = true, UseShellExecute = false })!
            : Process.Start("sleep", "30");
        var reports = new System.Collections.Concurrent.ConcurrentQueue<ChildProgram?>();
        using var watcher = new BusyWatcher(() => new Dictionary<string, int> { ["t"] = shell.Id }, (_, program) => reports.Enqueue(program));
        try
        {
            watcher.Resend("t");
            Assert.False(SpinWait.SpinUntil(() => !reports.IsEmpty, TimeSpan.FromSeconds(2)));
        }
        finally
        {
            shell.Kill();
        }
    }
}
