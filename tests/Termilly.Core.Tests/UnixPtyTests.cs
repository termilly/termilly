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

/// <summary>The Linux pseudo terminal, for real (these do nothing on Windows; ConPTY has its own tests).</summary>
public sealed class UnixPtyTests
{
    private static async Task<string> ReadUntilAsync(IPty pty, string text, StringBuilder seen, int seconds = 10)
    {
        var buffer = new byte[4096];
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(seconds));
        while (!seen.ToString().Contains(text, StringComparison.Ordinal))
        {
            var read = await pty.Output.ReadAsync(buffer, cancel.Token);
            if (read == 0)
            {
                break;
            }
            seen.Append(Encoding.UTF8.GetString(buffer, 0, read));
        }
        return seen.ToString();
    }

    private static async Task SendAsync(IPty pty, string text)
    {
        await pty.Input.WriteAsync(Encoding.UTF8.GetBytes(text));
        await pty.Input.FlushAsync();
    }

    [Fact]
    public async Task A_shell_runs_in_the_terminal_and_reports_its_exit_code()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24, "/tmp", new Dictionary<string, string> { ["TERMILLY_TEST"] = "yes" }));
        var seen = new StringBuilder();
        // Markers like tty-$((1+1)) only appear once the shell has run them, not in the echo of what was typed.
        await SendAsync(pty, "echo \"[$TERMILLY_TEST $(pwd) $TERM]\"; tty -s && echo tty-$((1+1)); exit 7\n");
        var output = await ReadUntilAsync(pty, "tty-2", seen);
        Assert.Contains("[yes /tmp xterm-256color]", output);
        Assert.Equal(7, await pty.Exited.WaitAsync(TimeSpan.FromSeconds(10)));
    }

    [Fact]
    public async Task Variables_of_the_terminal_that_started_termilly_stay_out()
    {
        if (!OperatingSystem.IsLinux())
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

    [Fact]
    public async Task Resizing_reaches_the_shell()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24));
        var seen = new StringBuilder();
        await SendAsync(pty, "stty size; echo first-$((1+1))\n");
        Assert.Contains("24 80", await ReadUntilAsync(pty, "first-2", seen));
        pty.Resize(132, 40);
        await SendAsync(pty, "stty size; echo second-$((2+2))\n");
        Assert.Contains("40 132", await ReadUntilAsync(pty, "second-4", seen));
    }

    [Fact]
    public async Task Ctrl_c_interrupts_whats_running_not_the_shell()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        using var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24));
        var seen = new StringBuilder();
        await SendAsync(pty, "sleep 30; echo slept-$((1+1))\n");
        await Task.Delay(500);
        await SendAsync(pty, "\x03");
        await SendAsync(pty, "echo here-$((3+3))\n");
        var output = await ReadUntilAsync(pty, "here-6", seen);
        Assert.DoesNotContain("slept-2", output);
        Assert.False(pty.Exited.IsCompleted);
    }

    [Fact]
    public async Task Closing_the_terminal_ends_the_shell_and_the_output()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var pty = PseudoTerminal.Start(new PtyOptions("/bin/sh", 80, 24));
        var exited = pty.Exited;
        pty.Dispose();
        Assert.Equal(128 + 1, await exited.WaitAsync(TimeSpan.FromSeconds(10))); // SIGHUP
    }
}
