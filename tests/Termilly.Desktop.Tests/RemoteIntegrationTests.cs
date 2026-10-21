using System.IO;
using System.Text;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Tests;

/// <summary>
/// Termilly on a server (RemoteIntegration.cs), as the Windows build has it. The scripts themselves run in
/// Termilly.Core.Tests on Linux.
/// </summary>
public sealed class RemoteIntegrationTests
{
    private static readonly string Scripts = Path.GetFullPath(Path.Combine(
        AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Termilly.Desktop", "shell", "remote"));

    private static string Base64(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    [Fact]
    public void A_remote_hook_speaks_only_for_its_own_terminal()
    {
        var sent = Base64("""{"pane":"other","session":"s1","tool":"Edit","file":"C:\\Windows\\win.ini","cwd":"C:\\"}""");
        var e = AgentHooks.ParseRemote("tab-1", "PreToolUse", sent)!;
        Assert.Equal("tab-1", e.Pane);
        Assert.Equal("Edit", e.Tool);
        Assert.Null(e.File); // the change preview must never copy this PC's file for a server's edit
        Assert.Null(e.Cwd);
        Assert.Equal("working", AgentHooks.StateFor(e));
    }

    [Fact]
    public void A_remote_subagent_stop_names_its_subagent_when_the_hook_sent_one()
    {
        var withId = AgentHooks.ParseRemote("tab-1", "SubagentStop", Base64("""{"session":"s1","agentId":"a1","agentType":"Explore","message":"Found it"}"""))!;
        Assert.Equal("a1", withId.Subagent?.AgentId);
        Assert.Equal("Explore", withId.Subagent?.AgentType);
        Assert.Null(withId.Subagent?.Transcript); // a server's path means nothing here
        Assert.Null(AgentHooks.StateFor(withId)); // a subagent stopping doesn't end the terminal's turn

        // Older Claude Code without agent_id: still the event, with no subagent (the page then finishes its rows when
        // the turn ends, js/subagents.js).
        var without = AgentHooks.ParseRemote("tab-1", "SubagentStop", Base64("""{"session":"s1"}"""))!;
        Assert.Equal("SubagentStop", without.Event);
        Assert.Null(without.Subagent?.AgentId);
    }

    [Fact]
    public void Odd_remote_hooks_are_dropped()
    {
        Assert.Null(AgentHooks.ParseRemote("t", "", ""));
        Assert.Null(AgentHooks.ParseRemote("t", "Stop\"", ""));
        Assert.Null(AgentHooks.ParseRemote("t", "Stop", new string('A', 20_000)));
        Assert.Equal("Stop", AgentHooks.ParseRemote("t", "Stop", "%%%")?.Event);
    }

    [Fact]
    public void Ssh_terminals_pass_the_variable_on()
    {
        var ssh = SessionProfiles.SshCommand;
        Assert.Equal($"{ssh} -o SendEnv=LC_TERMILLY host", RemoteIntegration.WithSendEnv($"{ssh} host"));
        Assert.Equal("mosh host", RemoteIntegration.WithSendEnv("mosh host"));
        var shell = new SessionProfile("pwsh", "PowerShell", "pwsh", "powershell", "pwsh.exe", ProfileSources.Local);
        Assert.Equal("1", SessionLaunch.EnvironmentFor(shell, null)["LC_TERMILLY"]);
    }

    [Fact]
    public void An_ssh_terminal_starts_with_keepalives_and_the_variable_sent()
    {
        // Shell integration once replaced the command line with the profile's own, dropping the keepalives.
        var host = new SessionProfile("ssh-db", "db", "db", "ssh", $"{SessionProfiles.SshCommand} db", ProfileSources.Ssh);
        var (commandLine, _) = SessionLaunch.Launch(host, new Dictionary<string, string>(), new AppSettings());
        Assert.Equal($"{SessionProfiles.SshCommand} -o SendEnv=LC_TERMILLY -o ServerAliveInterval=15 -o ServerAliveCountMax=3 db", commandLine);

        var (plain, _) = SessionLaunch.Launch(host, new Dictionary<string, string>(), new AppSettings { Shells = new() { Integration = false }, Ssh = new() { KeepAlive = false } });
        Assert.Equal($"{SessionProfiles.SshCommand} db", plain);
    }

    [Fact]
    public void The_installer_is_one_sh_script_with_unix_line_ends()
    {
        var installer = RemoteIntegration.Installer(Scripts);
        Assert.DoesNotContain('\r', installer);
        Assert.Contains("TERMILLY_REMOTE_VERSION=", installer);
        Assert.Equal(installer, Encoding.UTF8.GetString(Convert.FromBase64String(RemoteIntegration.Payload(Scripts))));
        var hooks = JsonNode.Parse(ClaudeHookSettings.ForRemote())!["hooks"]!.AsObject();
        Assert.Contains("termilly-hook.sh", hooks["PermissionRequest"]!.ToJsonString());
    }
}
