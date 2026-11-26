using System.Diagnostics;
using System.Text;
using Termilly.Pty;
using Termilly.Pty.Unix;

namespace Termilly.Core.Tests;

public sealed class CommandLineTests
{
    [Theory]
    [InlineData("bash", new[] { "bash" })]
    [InlineData("bash -l", new[] { "bash", "-l" })]
    [InlineData("  zsh   -i  ", new[] { "zsh", "-i" })]
    [InlineData("ssh 'my host' -p 22", new[] { "ssh", "my host", "-p", "22" })]
    [InlineData("sh -c \"echo \\\"hi\\\" $HOME\"", new[] { "sh", "-c", "echo \"hi\" $HOME" })]
    [InlineData(@"cat my\ file", new[] { "cat", "my file" })]
    [InlineData("", new string[0])]
    public void A_command_line_splits_like_a_shell_would(string line, string[] args) =>
        Assert.Equal(args, CommandLine.Split(line));
}

/// <summary>The Unix pseudo terminal (Linux, macOS), for real (these do nothing on Windows; ConPTY has its own tests).</summary>
public sealed class UnixPtyTests
{
    private static async Task<string> ReadUntilAsync(IPty pty, string text, StringBuilder seen, int seconds = 10)
    {
        var buffer = new byte[4096];
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        while (!seen.ToString().Contains(text, StringComparison.Ordinal))
        {
            // The token can't stop a read already waiting: the wait for it gives up instead (the test fails, not hangs).
            var read = await pty.Output.ReadAsync(buffer, cancel.Token).AsTask().WaitAsync(cancel.Token);
            if (read == 0)
            {
                break;
            }
            seen.Append(Encoding.UTF8.GetString(buffer, 0, read));
        }
        return seen.ToString();
    }

    /// <summary>
    /// The shells the terminal is tried with: sh, and zsh where there is one (macOS's default: one started directly got no
    /// controlling terminal there, so it never heard of a resize, nor got Ctrl+C's interrupt).
    /// </summary>
    public static TheoryData<string> Shells()
    {
        var shells = new TheoryData<string> { "/bin/sh" };
        if (File.Exists("/bin/zsh"))
        {
            shells.Add("/bin/zsh -f");
        }
        return shells;
    }

    private static async Task SendAsync(IPty pty, string text)
    {
        await pty.Input.WriteAsync(Encoding.UTF8.GetBytes(text));
        await pty.Input.FlushAsync();
    }

    [Fact]
    public async Task A_shell_runs_in_the_terminal_and_reports_its_exit_code()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24, "/usr", new Dictionary<string, string> { ["TERMILLY_TEST"] = "yes" }));
        var seen = new StringBuilder();
        // Markers like tty-$((1+1)) only appear once the shell has run them, not in the echo of what was typed.
        await SendAsync(pty, "echo \"[$TERMILLY_TEST $(pwd) $TERM]\"; tty -s && echo tty-$((1+1)); exit 7\n");
        var output = await ReadUntilAsync(pty, "tty-2", seen);
        Assert.Contains("[yes /usr xterm-256color]", output); // /usr: macOS's /tmp is a link to /private/tmp
        // Read on, as the window does: macOS's bash waits, as it exits, for what it wrote last to be read.
        var draining = Task.Run(async () =>
        {
            var buffer = new byte[4096];
            while (await pty.Output.ReadAsync(buffer) > 0)
            {
            }
        });
        Assert.Equal(7, await pty.Exited.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Variables_of_the_terminal_that_started_termilly_stay_out()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        // As when Termilly is started from GNOME Terminal: VTE's profile script would replace Termilly's prompt marks.
        Environment.SetEnvironmentVariable("VTE_VERSION", "7600");
        Environment.SetEnvironmentVariable("GNOME_TERMINAL_SCREEN", "/org/gnome/Terminal/screen/1");
        try
        {
            using var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24));
            var seen = new StringBuilder();
            await SendAsync(pty, "echo \"[${VTE_VERSION:-none} ${GNOME_TERMINAL_SCREEN:-none}]\"; echo done-$((2+3))\n");
            Assert.Contains("[none none]", await ReadUntilAsync(pty, "done-5", seen));
        }
        finally
        {
            Environment.SetEnvironmentVariable("VTE_VERSION", null);
            Environment.SetEnvironmentVariable("GNOME_TERMINAL_SCREEN", null);
        }
    }

    [Theory]
    [MemberData(nameof(Shells))]
    public async Task Resizing_reaches_the_shell(string shell)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions(shell, 80, 24));
        var seen = new StringBuilder();
        // The program is told (SIGWINCH), not only the terminal's size changed: Claude Code draws again on it.
        await SendAsync(pty, "trap 'echo told-$((3+4))' WINCH; stty size; echo first-$((1+1))\n");
        Assert.Contains("24 80", await ReadUntilAsync(pty, "first-2", seen));
        pty.Resize(132, 40);
        await Task.Delay(300);
        // dash runs a trap only on its way to the next command; zsh and bash at once, before it.
        await SendAsync(pty, "stty size; echo second-$((2+2))\n");
        var output = await ReadUntilAsync(pty, "second-4", seen);
        Assert.Contains("40 132", output);
        Assert.Contains("told-7", output);
    }

    [Theory]
    [MemberData(nameof(Shells))]
    public async Task The_terminal_is_the_shells_controlling_terminal(string shell)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions(shell, 80, 24));
        var seen = new StringBuilder();
        // /dev/tty opens only in a process that has a controlling terminal (job control and sudo need one).
        await SendAsync(pty, "(exec 3</dev/tty) 2>/dev/null && echo ctty-$((4+4)) || echo no-ctty-$((4+4))\n");
        Assert.Contains("ctty-8", await ReadUntilAsync(pty, "ctty-8", seen));
        Assert.DoesNotContain("no-ctty-8", seen.ToString());
    }

    [Theory]
    [MemberData(nameof(Shells))]
    public async Task Ctrl_c_interrupts_whats_running_not_the_shell(string shell)
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions(shell, 80, 24));
        // Its output read all along, as the window does: zsh waits on a terminal nobody reads.
        var output = new StringBuilder();
        var reading = Task.Run(async () =>
        {
            var buffer = new byte[4096];
            int read;
            while ((read = await pty.Output.ReadAsync(buffer)) > 0)
            {
                lock (output)
                {
                    output.Append(Encoding.UTF8.GetString(buffer, 0, read));
                }
            }
        });
        bool Shows(string text)
        {
            lock (output)
            {
                return output.ToString().Contains(text, StringComparison.Ordinal);
            }
        }
        // The shell is up first: a Ctrl+C while it starts throws away what was typed and not read yet.
        await SendAsync(pty, "echo ready-$((5+5))\n");
        Assert.True(SpinWait.SpinUntil(() => Shows("ready-10"), TimeSpan.FromSeconds(10)));
        // &&, not ;: bash (macOS's sh) goes on to the next command after an interrupted one, dash doesn't.
        await SendAsync(pty, "sleep 30 && echo slept-$((1+1))\n");
        // sleep is running before the Ctrl+C: what's interrupted is it, not a line not read yet.
        bool Sleeping() => Termilly.Desktop.BusyWatcher.Snapshot()
            .Any(p => p.ParentId == pty.ProcessId && Path.GetFileName(p.Exe) == "sleep");
        Assert.True(SpinWait.SpinUntil(Sleeping, TimeSpan.FromSeconds(10)));
        await SendAsync(pty, "\x03");
        Assert.True(SpinWait.SpinUntil(() => !Sleeping(), TimeSpan.FromSeconds(5)));
        // Typed a moment later: the interrupt throws away what's typed with it.
        await Task.Delay(500);
        await SendAsync(pty, "echo here-$((3+3))\n");
        Assert.True(SpinWait.SpinUntil(() => Shows("here-6"), TimeSpan.FromSeconds(10)));
        Assert.False(Shows("slept-2"));
        Assert.False(pty.Exited.IsCompleted);
    }

    [Fact]
    public async Task Closing_the_terminal_ends_the_shell_and_the_output()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24));
        var exited = pty.Exited;
        pty.Dispose();
        Assert.Equal(128 + 1, await exited.WaitAsync(TimeSpan.FromSeconds(10))); // SIGHUP
    }

    [Fact]
    public async Task Closing_a_terminal_a_program_still_holds_never_waits()
    {
        if (!OperatingSystem.IsLinux() && !OperatingSystem.IsMacOS())
        {
            return;
        }
        // A program that holds its terminal and ignores the hang-up, as an agent left running can (one that leads its
        // session, as the shell of the terminal does).
        var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh -c \"trap '' HUP; echo held; sleep 60\"", 80, 24));
        await ReadUntilAsync(pty, "held", new StringBuilder());
        try
        {
            // A reader waiting for output that doesn't come, as the terminal's pump does: on macOS a close used to wait
            // for it, forever while the program held the terminal.
            var reading = Task.Run(() =>
            {
                var buffer = new byte[4096];
                while (pty.Output.Read(buffer, 0, buffer.Length) > 0)
                {
                }
            });
            await Task.Delay(300);
            var closing = Task.Run(pty.Dispose);
            await closing.WaitAsync(TimeSpan.FromSeconds(2)); // closing the terminal didn't wait (a TimeoutException if it did)
            await reading.WaitAsync(TimeSpan.FromSeconds(5)); // and the reader ends
        }
        finally
        {
            using var program = Process.GetProcessById(pty.ProcessId);
            program.Kill(entireProcessTree: true);
        }
    }
}

/// <summary>macOS starts a terminal's program through bash, which takes the terminal as its controlling one.</summary>
public sealed class ControllingTerminalTests
{
    private const string Script = "if [ -n \"${TERMILLY_BASH_ENV+x}\" ]; then export BASH_ENV=\"$TERMILLY_BASH_ENV\"; unset TERMILLY_BASH_ENV; fi; exec \"$@\"";
    private static readonly List<string> Env = ["HOME=/Users/me", "PATH=/elsewhere"];

    /// <summary>Files that may be run: bash, zsh, a tool in a project; /usr/local/bin/notes is there but may not be run.</summary>
    private static readonly ControllingTerminal.Files Files = new(path => path is "/bin/bash" or "/bin/zsh" or "/usr/bin/ssh" or "/project/tool");

    private static ControllingTerminal.Start Of(List<string> argv, List<string>? env = null, string? cwd = null, bool mac = true) =>
        ControllingTerminal.Of(argv, env ?? Env, cwd, "/usr/bin:/bin", mac, Files);

    [Fact]
    public void On_macOS_a_program_starts_through_bash_by_the_full_path_the_apps_PATH_gives()
    {
        // The app's own PATH, as posix_spawnp searches it, not the terminal's (PATH=/elsewhere).
        Assert.Equal(["/bin/bash", "-c", Script, "termilly", "/bin/zsh", "-l"], Of(["zsh", "-l"]).Argv);
        Assert.Equal(["/bin/bash", "-c", Script, "termilly", "/usr/bin/ssh", "my host", "-p", "22"], Of(["ssh", "my host", "-p", "22"]).Argv);
        // A path from the working directory.
        Assert.Equal(["/bin/bash", "-c", Script, "termilly", "/project/tool"], Of(["./tool"], cwd: "/project").Argv);
        Assert.Equal(Env, Of(["zsh"]).Environment);
    }

    [Fact]
    public void BASH_ENV_goes_around_bash_to_the_program()
    {
        var start = Of(["zsh"], ["BASH_ENV=/Users/me/.bashenv", "HOME=/Users/me"]);
        Assert.Equal(["TERMILLY_BASH_ENV=/Users/me/.bashenv", "HOME=/Users/me"], start.Environment);
    }

    [Fact]
    public void Elsewhere_or_for_a_program_that_cant_start_it_starts_as_it_is()
    {
        Assert.Equal(["zsh", "-l"], Of(["zsh", "-l"], mac: false).Argv);
        // Not there, or there and not to be run: it fails to start as before, rather than bash saying so in the terminal.
        Assert.Equal(["nosuch"], Of(["nosuch"]).Argv);
        Assert.Equal(["/usr/local/bin/notes"], Of(["/usr/local/bin/notes"]).Argv);
        // No bash: as it is.
        Assert.Equal(["zsh"], ControllingTerminal.Of(["zsh"], Env, null, "/bin", mac: true, new(path => path == "/bin/zsh")).Argv);
    }
}
