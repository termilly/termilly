using System.Diagnostics;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>Termilly on a server (shell/remote, RemoteIntegration.cs): what it reports and how it's set up.</summary>
public sealed class RemoteIntegrationTests : IDisposable
{
    private static readonly string Scripts = Path.GetFullPath(Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Termilly.Desktop", "shell", "remote"));

    private readonly string _home = Path.Combine(Path.GetTempPath(), "termilly-remote-" + Guid.NewGuid().ToString("N"));

    public RemoteIntegrationTests() => Directory.CreateDirectory(_home);

    public void Dispose() => Directory.Delete(_home, recursive: true);

    private static string Base64(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    [Fact]
    public void A_remote_hook_speaks_only_for_its_own_terminal()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        var sent = Base64("""{"event":"PreToolUse","pane":"other","session":"s1","tool":"Bash","target":"git","file":"/etc/passwd","cwd":"/srv","dirs":["/x"]}""");
        var e = AgentHooks.ParseRemote("tab-1", "PreToolUse", sent);

        Assert.NotNull(e);
        Assert.Equal("tab-1", e.Pane);
        Assert.Equal("PreToolUse", e.Event);
        Assert.Equal("s1", e.Session);
        Assert.Equal("Bash", e.Tool);
        Assert.Equal("git", e.Target);
        // Paths on the server mean nothing here (and the change preview would read this PC's files).
        Assert.Null(e.File);
        Assert.Null(e.Cwd);
        Assert.Null(e.Dirs);
    }

    [Fact]
    public void A_remote_hook_without_a_readable_message_still_reports_its_event()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        Assert.Equal("Stop", AgentHooks.ParseRemote("t", "Stop", "")?.Event);
        Assert.Equal("Stop", AgentHooks.ParseRemote("t", "Stop", "not base64!")?.Event);
        Assert.Equal("Stop", AgentHooks.ParseRemote("t", "Stop", Base64("[1,2]"))?.Event);
    }

    [Fact]
    public void Odd_remote_hooks_are_dropped()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        Assert.Null(AgentHooks.ParseRemote("t", null, ""));
        Assert.Null(AgentHooks.ParseRemote("t", "Pre;Tool", ""));
        Assert.Null(AgentHooks.ParseRemote("t", "Stop", new string('A', 20_000)));
    }

    [Fact]
    public void Ssh_passes_the_variable_on()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        var ssh = SessionProfiles.SshCommand;
        Assert.Equal($"{ssh} -o SendEnv=LC_TERMILLY -J bastion deploy@db1", RemoteIntegration.WithSendEnv($"{ssh} -J bastion deploy@db1"));
        var own = $"{ssh} -o SendEnv=LC_TERMILLY host";
        Assert.Equal(own, RemoteIntegration.WithSendEnv(own));
        Assert.Equal("mosh host", RemoteIntegration.WithSendEnv("mosh host"));
    }

    [Fact]
    public void Every_terminal_says_it_is_in_Termilly()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        var profile = new SessionProfile("x", "x", "x", "bash", "x", ProfileSources.Local);
        Assert.Equal("1", SessionLaunch.EnvironmentFor(profile, null)[RemoteIntegration.Variable]);
    }

    [Fact]
    public void The_installer_carries_the_scripts_and_their_version()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        var installer = RemoteIntegration.Installer(Scripts);
        Assert.Contains("cat > \"$d/termilly.sh\"", installer);
        Assert.Contains("cat > \"$d/termilly-hook.sh\"", installer);
        Assert.Contains("cat > \"$d/claude-settings.json\"", installer);
        Assert.DoesNotContain('\r', installer);
        Assert.True(RemoteIntegration.VersionIn(Scripts) >= 1);

        // The hooks run the remote hook script, for every event the local hook has.
        var settings = JsonNode.Parse(ClaudeHookSettings.ForRemote())!["hooks"]!.AsObject();
        Assert.Contains("PreToolUse", settings.Select(p => p.Key));
        Assert.Contains("termilly-hook.sh\" hook 1 Stop", settings["Stop"]!.ToJsonString().Replace("\\u0022", "\""));
    }

    [Fact]
    public void The_install_line_stays_out_of_history_and_reads_exactly_the_installer()
    {
        if (!OperatingSystem.IsLinux())
        {
            return; // the Windows build's own copy: Termilly.Desktop.Tests
        }
        var line = RemoteIntegration.InstallCommand(1234);
        Assert.StartsWith(" ", line);
        Assert.Contains("head -c 1234", line);
        Assert.Contains("stty -echo -icanon", line);
        Assert.DoesNotContain('\n', line);
    }

    // ---- The scripts themselves (Linux) ----

    private static (int Code, string Output) Run(string file, string arguments, string home, string? input = null, string? cwd = null)
    {
        var start = new ProcessStartInfo(file, arguments)
        {
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = cwd ?? home,
        };
        start.Environment["HOME"] = home;
        start.Environment["SHELL"] = "/bin/bash";
        using var process = Process.Start(start)!;
        process.StandardInput.Write(input ?? "");
        process.StandardInput.Close();
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();
        return (process.ExitCode, output);
    }

    [Fact]
    public void The_scripts_parse()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        foreach (var script in new[] { "termilly-hook.sh", "uninstall.sh" })
        {
            Assert.Equal(0, Run("/bin/sh", $"-n \"{Path.Combine(Scripts, script)}\"", _home).Code);
        }
        Assert.Equal(0, Run("/bin/bash", $"-n \"{Path.Combine(Scripts, "termilly.sh")}\"", _home).Code);
        if (File.Exists("/usr/bin/zsh"))
        {
            Assert.Equal(0, Run("/usr/bin/zsh", $"-n \"{Path.Combine(Scripts, "termilly.sh")}\"", _home).Code);
        }
    }

    [Fact]
    public void Installing_and_removing_leaves_the_rc_file_as_it_was()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var bashrc = Path.Combine(_home, ".bashrc");
        const string original = "# mine\nalias ll='ls -l'";  // no newline at the end
        File.WriteAllText(bashrc, original);

        var installed = Run("/bin/sh", "-s", _home, RemoteIntegration.Installer(Scripts));
        Assert.Equal(0, installed.Code);
        Assert.Contains("Termilly is set up on this host.", installed.Output);
        foreach (var file in new[] { "termilly.sh", "termilly-hook.sh", "uninstall.sh", "claude-settings.json" })
        {
            Assert.True(File.Exists(Path.Combine(_home, ".termilly", file)), file);
        }
        Assert.Contains(".termilly/termilly.sh", File.ReadAllText(bashrc));
        Assert.False(File.Exists(Path.Combine(_home, ".zshrc"))); // bash user without one: left alone

        // Twice is the same as once.
        Run("/bin/sh", "-s", _home, RemoteIntegration.Installer(Scripts));
        Assert.Single(File.ReadAllLines(bashrc), l => l.Contains(".termilly/termilly.sh"));

        var removed = Run("/bin/sh", Path.Combine(_home, ".termilly", "uninstall.sh"), _home);
        Assert.Equal(0, removed.Code);
        Assert.False(Directory.Exists(Path.Combine(_home, ".termilly")));
        Assert.Equal(original + "\n", File.ReadAllText(bashrc));
    }

    /// <summary>Runs <paramref name="input"/> in an interactive bash with the integration installed, in a terminal.</summary>
    [System.Runtime.Versioning.SupportedOSPlatform("linux")]
    private async Task<string> InTerminal(string input, string until, string? cwd = null, bool termilly = true)
    {
        Run("/bin/sh", "-s", _home, RemoteIntegration.Installer(Scripts));
        // As sshd starts it: no TERM_PROGRAM (ssh doesn't pass it), and LC_TERMILLY only from Termilly.
        var vars = new Dictionary<string, string>
        {
            ["HOME"] = _home, ["PATH"] = "/usr/local/bin:/usr/bin:/bin", ["TERM_PROGRAM"] = "", ["TMUX"] = "",
            [RemoteIntegration.Variable] = termilly ? "1" : "",
        };
        using var pty = Termilly.Pty.PseudoTerminal.Start(new Termilly.Pty.PtyOptions("/bin/bash -i", 200, 24, cwd ?? _home, vars));
        await pty.Input.WriteAsync(Encoding.UTF8.GetBytes(input));
        await pty.Input.FlushAsync();
        var seen = new StringBuilder();
        var buffer = new byte[4096];
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(15));
        try
        {
            while (!seen.ToString().Contains(until, StringComparison.Ordinal))
            {
                var read = await pty.Output.ReadAsync(buffer, cancel.Token);
                if (read == 0)
                {
                    break;
                }
                seen.Append(Encoding.UTF8.GetString(buffer, 0, read));
            }
        }
        catch (OperationCanceledException)
        {
        }
        return seen.ToString();
    }

    [Fact]
    public async Task A_remote_shell_reports_its_prompts_folder_and_repository()
    {
        if (!OperatingSystem.IsLinux() || !File.Exists("/usr/bin/git"))
        {
            return;
        }
        var repo = Directory.CreateDirectory(Path.Combine(_home, "proj")).FullName;
        Run("/usr/bin/git", "init -q -b main", _home, cwd: repo);
        File.WriteAllText(Path.Combine(repo, "a.txt"), "x");

        var seen = await InTerminal("false; echo done-$((2+2))\n", "done-4", repo);
        Assert.Contains("\e]633;P;TermillyRemote=", seen);
        Assert.Contains($"\e]633;P;TermillyGit=main|1|0|0||{repo}\a", seen);
        Assert.Contains($"\e]7;file://", seen);
        Assert.Contains("\e]133;A\a", seen);
        Assert.Contains("\e]633;E;false; echo done-$((2+2))\a", seen);
        Assert.Contains("\e]133;C\a", seen);
    }

    [Fact]
    public async Task Outside_Termilly_it_stays_quiet()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var seen = await InTerminal("echo done-$((2+2)); exit\n", "done-4", termilly: false);
        Assert.Contains("done-4", seen);
        Assert.DoesNotContain("Termilly", seen);
        Assert.DoesNotContain("\e]133;", seen);
    }

    [Fact]
    public async Task Claude_gets_the_hooks_and_the_terminal_to_report_to()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        // A stand-in claude on PATH that shows what it was started with.
        var bin = Directory.CreateDirectory(Path.Combine(_home, ".local", "bin")).FullName;
        var fake = Path.Combine(bin, "claude");
        File.WriteAllText(fake, "#!/bin/sh\necho \"args=[$*] tty=[$TERMILLY_TTY]\"\n");
        File.SetUnixFileMode(fake, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);

        // Its input a pipe, as in "git diff | claude -p review": the terminal is still found.
        var seen = await InTerminal($"PATH=\"{bin}:$PATH\"; echo x | claude -p hi; echo done-$((2+2))\n", "done-4");
        Assert.Matches(@"args=\[--settings \S+/\.termilly/claude-settings\.json -p hi\] tty=\[/dev/pts/\d+\]", seen);
    }

    [Fact]
    public async Task A_hook_without_a_terminal_reports_to_claudes()
    {
        if (!OperatingSystem.IsLinux() || !File.Exists("/usr/bin/setsid"))
        {
            return;
        }
        // As Claude Code runs hooks: in a session of their own, where /dev/tty doesn't open.
        var seen = await InTerminal(
            "echo '{}' | TERMILLY_TTY=/dev/$(ps -o tty= -p $$ | tr -d ' ') setsid -w \"$HOME/.termilly/termilly-hook.sh\" hook 1 Stop; echo done-$((2+2))\n", "done-4");
        Assert.True(seen.Contains("\e]1337;TermillyHook=1;Stop;", StringComparison.Ordinal), seen.Replace("\e", "<ESC>"));
    }

    [Fact]
    public async Task The_remote_hook_reports_through_the_terminal()
    {
        if (!OperatingSystem.IsLinux() || !File.Exists("/usr/bin/python3"))
        {
            return;
        }
        var payload = """{"session_id":"abc","tool_name":"Bash","tool_input":{"command":"git status --short","description":"x"},"cwd":"/srv/app"}""";
        File.WriteAllText(Path.Combine(_home, "payload.json"), payload);
        var seen = await InTerminal("\"$HOME/.termilly/termilly-hook.sh\" hook 1 PreToolUse < \"$HOME/payload.json\"; echo done-$((2+2))\n", "done-4");

        var m = System.Text.RegularExpressions.Regex.Match(seen, "\e\\]1337;TermillyHook=1;PreToolUse;([A-Za-z0-9+/=]+)\a");
        Assert.True(m.Success, seen);
        var e = AgentHooks.ParseRemote("tab", "PreToolUse", m.Groups[1].Value)!;
        Assert.Equal("abc", e.Session);
        Assert.Equal("Bash", e.Tool);
        Assert.Equal("git", e.Target);
        // Only the first word of a command leaves the server, never the command.
        Assert.DoesNotContain("status --short", Encoding.UTF8.GetString(Convert.FromBase64String(m.Groups[1].Value)));
    }
}
