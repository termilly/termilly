extern alias agent;

using agent::Termilly.Agent;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The agent helper on Linux: terminals find the claude shim first, and the shim finds the real claude.</summary>
public sealed class AgentTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-agent-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private string Folder(string name) => Directory.CreateDirectory(Path.Combine(_root, name)).FullName;

    private static string Program(string folder, string name, bool executable = true)
    {
        var path = Path.Combine(folder, name);
        File.WriteAllText(path, "#!/bin/sh\n");
        if (executable && !OperatingSystem.IsWindows())
        {
            File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        }
        return path;
    }

    [Fact]
    public void The_agent_folder_goes_first_on_PATH()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var vars = new Dictionary<string, string> { ["PATH"] = "/usr/local/bin:/usr/bin" };
        var withAgent = SessionLaunch.WithAgent(vars, "pane1", "termilly-1", "/data/agent/claude-settings.json", "/opt/termilly/agent");
        Assert.Equal("/opt/termilly/agent:/usr/local/bin:/usr/bin", withAgent["PATH"]);
        Assert.Equal("pane1", withAgent["TERMILLY_PANE_ID"]);
        Assert.Equal("termilly-1", withAgent["TERMILLY_PIPE"]);
        Assert.Equal("/opt/termilly/agent", withAgent["TERMILLY_AGENT_DIR"]);
    }

    [Fact]
    public async Task Bash_keeps_the_agent_folder_first_after_a_login_profile_moves_it()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        // As Ubuntu's ~/.profile does with ~/.local/bin, where Claude Code installs.
        var home = Folder("home");
        File.WriteAllText(Path.Combine(home, ".profile"), "PATH=\"$HOME/.local/bin:$PATH\"\n");
        var agent = Folder("agent");
        var vars = SessionLaunch.WithAgent(new Dictionary<string, string> { ["HOME"] = home, ["PATH"] = "/usr/bin:/bin" }, "p", "pipe", "s", agent);
        var profile = new SessionProfile("bash", "bash", "/bin/bash", "bash", "/bin/bash -l", ProfileSources.Local);
        var (commandLine, environment) = SessionLaunch.WithShellIntegration(profile, vars);

        using var pty = Termilly.Pty.PseudoTerminal.Start(new Termilly.Pty.PtyOptions(commandLine, 200, 24, home, environment));
        var input = System.Text.Encoding.UTF8.GetBytes("echo \"[${PATH%%:*}]\"; echo done-$((2+2))\n");
        await pty.Input.WriteAsync(input);
        await pty.Input.FlushAsync();
        var seen = new System.Text.StringBuilder();
        var buffer = new byte[4096];
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(10));
        while (!seen.ToString().Contains("done-4", StringComparison.Ordinal))
        {
            var read = await pty.Output.ReadAsync(buffer, cancel.Token);
            if (read == 0)
            {
                break;
            }
            seen.Append(System.Text.Encoding.UTF8.GetString(buffer, 0, read));
        }
        Assert.Contains($"[{agent}]", seen.ToString());
    }

    [Fact]
    public async Task Pwsh_typed_at_bash_prompt_marks_its_own_commands()
    {
        if (!OperatingSystem.IsLinux() || !File.Exists("/usr/bin/pwsh"))
        {
            return;
        }
        var script = Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Termilly.Desktop", "shell", "termilly.ps1");
        var profile = new SessionProfile("bash", "bash", "/bin/bash", "bash", "/bin/bash --norc --noprofile -i", ProfileSources.Local);
        var (commandLine, environment) = SessionLaunch.WithShellIntegration(profile, new Dictionary<string, string>(), Path.GetFullPath(script));

        using var pty = Termilly.Pty.PseudoTerminal.Start(new Termilly.Pty.PtyOptions(commandLine, 200, 24, "/tmp", environment));
        await pty.Input.WriteAsync(System.Text.Encoding.UTF8.GetBytes("pwsh\n"));
        await pty.Input.FlushAsync();
        var seen = new System.Text.StringBuilder();
        var buffer = new byte[4096];
        using var cancel = new CancellationTokenSource(TimeSpan.FromSeconds(20));
        async Task Until(string text)
        {
            while (!seen.ToString().Contains(text, StringComparison.Ordinal))
            {
                var read = await pty.Output.ReadAsync(buffer, cancel.Token);
                if (read == 0)
                {
                    return;
                }
                var chunk = System.Text.Encoding.UTF8.GetString(buffer, 0, read);
                seen.Append(chunk);
                if (chunk.Contains("\e[6n", StringComparison.Ordinal))
                {
                    // pwsh asks where the cursor is and waits for the answer, which xterm.js gives in Termilly.
                    await pty.Input.WriteAsync(System.Text.Encoding.UTF8.GetBytes("\e[1;1R"));
                    await pty.Input.FlushAsync();
                }
            }
        }
        await Until("\e]133;B"); // pwsh's prompt: only its integration marks where input starts
        seen.Clear();
        await pty.Input.WriteAsync(System.Text.Encoding.UTF8.GetBytes("Start-Sleep -Milliseconds 100; 'slept-' + (2+3)\r"));
        await pty.Input.FlushAsync();
        await Until("\e]133;D;0");
        Assert.Contains("\e]133;C", seen.ToString());
        Assert.Contains("slept-5", seen.ToString());
    }

    [Fact]
    public void The_shim_finds_the_real_claude_after_itself()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var shim = Folder("agent");
        Program(shim, "claude");
        var notRunnable = Folder("notes");
        Program(notRunnable, "claude", executable: false);
        var real = Program(Folder("bin"), "claude");

        var path = string.Join(':', shim, notRunnable, Path.GetDirectoryName(real));
        Assert.Equal(real, Shim.FindReal(path, pathExt: null, shimDirectory: shim + "/"));
    }

    [Fact]
    public void Without_another_claude_the_shim_finds_none()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var shim = Folder("agent");
        Program(shim, "claude");
        Assert.Null(Shim.FindReal(shim + ":" + Folder("empty"), pathExt: null, shimDirectory: shim));
    }

    [Fact]
    public void Helper_names_have_no_exe()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        Assert.Equal("termilly-hook", Path.GetFileName(AgentHooks.HookExe));
        Assert.Equal("ssh", AppPaths.Exe("ssh"));
    }
}
