using System.IO;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>
/// A background task's output file (Claude Code writes one per task) and its process, on every system: Windows finds
/// who holds the file with the Restart Manager, Linux in /proc, macOS with lsof.
/// </summary>
public sealed class TaskProcessesTests
{
    private const string Session = "s1";
    private const string TaskId = "bk1u88xlt";

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void Stop_ends_the_process_that_writes_the_tasks_file_and_no_other(bool shellHolds)
    {
        var folder = Path.Combine(Path.GetTempPath(), $"termilly-stop-{Guid.NewGuid():N}");
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, "task.output");
        var other = Path.Combine(folder, "other.output");
        using var task = Holding(file, shellHolds);
        using var bystander = Holding(other, shellHolds);
        try
        {
            WaitFor(() => File.Exists(file) && File.Exists(other));
            // The test runner stands in for the agent that starts tasks.
            using var self = System.Diagnostics.Process.GetCurrentProcess();
            Assert.True(new TaskProcesses([self.ProcessName]).Stop(Environment.ProcessId, file));
            Assert.True(task.WaitForExit(5000));
            Assert.False(bystander.HasExited);
        }
        finally
        {
            bystander.Kill(entireProcessTree: true);
            bystander.WaitForExit(5000);
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public void Stop_by_command_ends_the_shell_running_it_and_no_other()
    {
        // Codex's tasks have no file: each is the shell an agent started its command in.
        string Command(int seconds) => OperatingSystem.IsWindows() ? $"ping -n {seconds} 127.0.0.1" : $"sleep {seconds}; echo done";
        using var task = Running(Command(61));
        using var bystander = Running(Command(62));
        try
        {
            using var self = System.Diagnostics.Process.GetCurrentProcess();
            var processes = new TaskProcesses([self.ProcessName]);
            WaitFor(() => processes.StopCommand(Environment.ProcessId, Command(61) + "…"));
            Assert.True(task.WaitForExit(5000));
            Assert.False(bystander.HasExited);
            Assert.False(processes.StopCommand(Environment.ProcessId, "nothing runs this"));
        }
        finally
        {
            bystander.Kill(entireProcessTree: true);
            bystander.WaitForExit(5000);
        }
    }

    private static System.Diagnostics.Process Running(string command)
    {
        var start = OperatingSystem.IsWindows()
            ? new System.Diagnostics.ProcessStartInfo("cmd.exe", $"/c {command}")
            : new System.Diagnostics.ProcessStartInfo("/bin/sh", ["-c", command]);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        return System.Diagnostics.Process.Start(start)!;
    }

    /// <summary>
    /// A shell whose output goes to <paramref name="file"/> for a minute, as a background task's does: the shell holds
    /// the file itself (as an agent's bash does), or only the command it hands it to does.
    /// </summary>
    private static System.Diagnostics.Process Holding(string file, bool shellHolds)
    {
        // cmd reads its command line as it is, quotes and all; sh takes the command as one argument. A redirected group
        // keeps cmd holding the file; a single command's cmd hands it on.
        var start = OperatingSystem.IsWindows()
            ? new System.Diagnostics.ProcessStartInfo("cmd.exe", shellHolds
                ? $"/c (ping -n 60 127.0.0.1 & echo done) > \"{file}\"" : $"/c ping -n 60 127.0.0.1 > \"{file}\"")
            : new System.Diagnostics.ProcessStartInfo("/bin/sh", ["-c", shellHolds
                ? $"exec > \"{file}\"; sleep 60; echo done" : $"sleep 60 > \"{file}\"; echo done"]);
        start.UseShellExecute = false;
        start.CreateNoWindow = true;
        return System.Diagnostics.Process.Start(start)!;
    }

    private static void WaitFor(Func<bool> done)
    {
        var until = DateTime.UtcNow + TimeSpan.FromSeconds(5);
        while (!done() && DateTime.UtcNow < until)
        {
            Thread.Sleep(20);
        }
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
