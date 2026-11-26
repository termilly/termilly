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
            WaitFor(() => processes.StopCommand(Environment.ProcessId, Command(61) + "…", DateTimeOffset.Now));
            Assert.True(task.WaitForExit(5000));
            Assert.False(bystander.HasExited);
            Assert.False(processes.StopCommand(Environment.ProcessId, "nothing runs this", DateTimeOffset.Now));
        }
        finally
        {
            bystander.Kill(entireProcessTree: true);
            bystander.WaitForExit(5000);
        }
    }

    [Fact]
    public void Stop_by_command_finds_it_however_its_shell_was_handed_the_quotes()
    {
        // The agent's shell gets the command quoted again (PowerShell's \"x\", sh's '\''x'\''): found all the same.
        var (runs, hookSays) = OperatingSystem.IsWindows()
            ? ("ping -n 64 127.0.0.1 & echo \\\"done\\\"", "ping -n 64 127.0.0.1 & echo \"done\"")
            : ("sh -c 'sleep 64; echo '\\''done'\\'''", "sleep 64; echo 'done'");
        using var task = Running(runs);
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        var processes = new TaskProcesses([self.ProcessName]);
        var stopped = false;
        WaitFor(() => stopped = processes.StopCommand(Environment.ProcessId, hookSays, DateTimeOffset.Now));
        Assert.True(stopped);
        Assert.True(task.WaitForExit(5000));
    }

    [Theory]
    // As the agent's shell holds it: as it was, or quoted again for PowerShell (after its line break) or for sh.
    [InlineData("sleep 5; echo x", "sh -c 'sleep 5; echo x'", true)]
    [InlineData("echo \"done\"", "powershell -Command \"try {} catch {}\n echo \\\"done\\\"\"", true)]
    [InlineData("echo 'a b'", "bash -c 'echo '\\''a b'\\'''", true)]
    // Exact: a different spacing or quoting is another command, inside quotes too.
    [InlineData("echo 'a b'", "bash -c 'echo ab'", false)]
    [InlineData("echo ab", "bash -c 'echo a b'", false)]
    [InlineData("echo 'a b'", "bash -c 'echo '\\''a  b'\\'''", false)]
    [InlineData("echo \"a b\"", "powershell -Command \"echo \\\"a  b\\\"\"", false)]
    // A whole command ends where a word does: a longer one that starts the same isn't it.
    [InlineData("sleep 60", "sh -c 'sleep 600'", false)]
    [InlineData("sleep 60", "sh -c 'sleep 60.5'", false)]
    [InlineData("sleep 60", "sh -c 'sleep 60'", true)]
    [InlineData("sleep 60", "sh -c 'sleep 60&& echo done'", true)]
    // Windows doubles the backslashes before a quote, and at the argument's end.
    [InlineData("dir C:\\Windows\\", "powershell.exe -Command \"x\ndir C:\\Windows\\\\\"", true)]
    [InlineData("Get-ChildItem \"C:\\Program Files\\\"", "powershell.exe -Command \"x\nGet-ChildItem \\\"C:\\Program Files\\\\\\\"\"", true)]
    [InlineData("echo \\\"x\\\"", "powershell.exe -Command \"x\necho \\\\\\\"x\\\\\\\"\"", true)]
    [InlineData("Test-Path \"C:\\Users\\\" -PathType Container", "powershell.exe -Command \"x\nTest-Path \\\"C:\\Users\\\\\\\" -PathType Container\"", true)]
    // It starts where a word does: a longer command ending the same isn't it.
    [InlineData("npm test", "sh -c 'pnpm test'", false)]
    [InlineData("Sleep 75", "powershell.exe -Command \"x\nStart-Sleep 75\"", false)]
    [InlineData("Start-Sleep 60", "powershell -Command \"Start-Sleep 600\"", false)]
    [InlineData("sleep 60", "sh -c 'sleep 60; echo done'", true)]
    public void A_command_is_found_in_its_shell_command_line_as_its_shell_was_handed_it(string command, string commandLine, bool found)
    {
        Assert.Equal(found, TaskProcesses.Holds(commandLine, command));
    }

    [Fact]
    public void A_node_task_under_the_agent_is_stopped()
    {
        // A `node x.js` the agent runs: node starts agents too, but one under the agent is its task.
        var (program, args) = ("node", "-e setTimeout(()=>{},64000)");
        using var task = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(program, args) { CreateNoWindow = true, UseShellExecute = false })!;
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        var processes = new TaskProcesses([self.ProcessName, program]);
        // As the system shows it (Windows may name the program by its full path).
        var command = ProcessCommandLines.Of([task.Id])[task.Id].Trim();
        var stopped = false;
        WaitFor(() => stopped = processes.StopCommand(Environment.ProcessId, command, DateTimeOffset.Now));
        Assert.True(stopped);
        Assert.True(task.WaitForExit(5000));
    }

    [Fact]
    public void Stop_finds_the_last_command_bash_ran_in_its_own_place()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // bash -c's exec of its last command: Linux and macOS
        }
        // bash runs `sleep 66` in its own process, which then shows `sleep 66` alone.
        var started = DateTimeOffset.Now;
        using var task = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("bash", ["-c", "cd /tmp && sleep '66'"]) { UseShellExecute = false })!;
        using var self = System.Diagnostics.Process.GetCurrentProcess();
        var processes = new TaskProcesses([self.ProcessName]);
        var stopped = false;
        WaitFor(() => stopped = processes.StopCommand(Environment.ProcessId, "cd /tmp && sleep '66'", started));
        Assert.True(stopped);
        Assert.True(task.WaitForExit(5000));
    }

    [Fact]
    public void An_older_process_running_the_same_last_command_is_left_alone()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // bash -c's exec of its last command: Linux and macOS
        }
        // Another task's `sleep 68`, started well before; the task asked for (cd somewhere && sleep 68) never ran.
        using var older = System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo("sleep", "68") { UseShellExecute = false })!;
        try
        {
            Thread.Sleep(3000);
            using var self = System.Diagnostics.Process.GetCurrentProcess();
            var processes = new TaskProcesses([self.ProcessName]);
            Assert.False(processes.StopCommand(Environment.ProcessId, "cd /nowhere && sleep 68", DateTimeOffset.Now));
            Assert.False(older.HasExited);
        }
        finally
        {
            older.Kill();
        }
    }

    [Fact]
    public void A_command_cut_short_is_found_by_its_start()
    {
        // The hook's "sleep 60…" may be the start of "sleep 600".
        Assert.True(TaskProcesses.Holds("sh -c 'sleep 600'", "sleep 60", whole: false));
    }

    [Fact]
    public void Of_the_same_command_twice_Stop_ends_the_one_started_nearest_the_task()
    {
        var command = OperatingSystem.IsWindows() ? "ping -n 63 127.0.0.1" : "sleep 63; echo done";
        using var earlier = Running(command);
        Thread.Sleep(1500);
        using var task = Running(command);
        var started = new DateTimeOffset(task.StartTime);
        try
        {
            using var self = System.Diagnostics.Process.GetCurrentProcess();
            var processes = new TaskProcesses([self.ProcessName]);
            WaitFor(() => processes.StopCommand(Environment.ProcessId, command, started));
            Assert.True(task.WaitForExit(5000));
            Assert.False(earlier.HasExited);
        }
        finally
        {
            earlier.Kill(entireProcessTree: true);
            earlier.WaitForExit(5000);
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
