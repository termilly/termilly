using System.Diagnostics;
using System.Runtime.Versioning;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The activity spinner on Linux: what a terminal's shell runs, from /proc.</summary>
public sealed class BusyWatcherTests
{
    [Fact]
    public void The_snapshot_has_a_running_command_under_its_parent()
    {
        if (!OperatingSystem.IsLinux())
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
    private static ProcessEntry Find(List<ProcessEntry> all, int id) => Assert.Single(all, p => p.Id == id);

    [Fact]
    public void A_command_under_the_shell_is_busy_and_an_editor_is_not()
    {
        if (!OperatingSystem.IsLinux())
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
}
