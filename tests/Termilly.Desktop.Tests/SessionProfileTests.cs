using System.IO;
using Termilly.Pty;

namespace Termilly.Desktop.Tests;

public sealed class SessionProfileTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public SessionProfileTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    // ---- ~/.ssh/config ----

    [Fact]
    public void Concrete_host_aliases_are_listed_with_user_and_host_name()
    {
        var hosts = SshConfig.Parse("""
            # personal
            Host dev-linux
                HostName 10.0.0.5
                User alex

            Host prod-web-01 prod-web-02
              HostName=web.example.com
              User deploy   # trailing comment
            """);

        Assert.Equal(["dev-linux", "prod-web-01", "prod-web-02"], hosts.Select(h => h.Alias));
        Assert.Equal(new SshHost("dev-linux", "10.0.0.5", "alex"), hosts[0]);
        Assert.Equal(new SshHost("prod-web-02", "web.example.com", "deploy"), hosts[2]);
    }

    [Fact]
    public void Patterns_negations_and_match_blocks_are_not_hosts()
    {
        var hosts = SshConfig.Parse("""
            Host *
              ServerAliveInterval 30
            Host *.internal bastion? !skip real
              User ops
            Match host builder
              User ci
            Host "quoted alias"
            """);

        // "quoted alias" has a space, so it can't go on a command line as is.
        Assert.Equal(["real"], hosts.Select(h => h.Alias));
        Assert.Equal("ops", hosts[0].User);
    }

    [Fact]
    public void Settings_after_match_do_not_leak_into_the_previous_host()
    {
        var hosts = SshConfig.Parse("Host a\nMatch all\n  User root\n");
        Assert.Null(hosts.Single().User);
    }

    [Fact]
    public void Include_is_followed_relative_to_the_ssh_folder_and_first_mention_wins()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "config.d"));
        File.WriteAllText(Path.Combine(_dir, "config.d", "work.conf"), "Host work-db\n  HostName db.work\nHost home\n  User other\n");
        File.WriteAllText(Path.Combine(_dir, "config"), "Host home\n  User me\nInclude config.d/*.conf\n");

        var hosts = SshConfig.Read(Path.Combine(_dir, "config"));

        Assert.Equal(["home", "work-db"], hosts.Select(h => h.Alias));
        Assert.Equal("me", hosts[0].User);
        Assert.Equal("db.work", hosts[1].HostName);
    }

    [Fact]
    public void Include_loops_stop()
    {
        File.WriteAllText(Path.Combine(_dir, "config"), "Host a\nInclude config\n");
        Assert.Single(SshConfig.Read(Path.Combine(_dir, "config")));
    }

    [Fact]
    public void A_missing_config_has_no_hosts() =>
        Assert.Empty(SshConfig.Read(Path.Combine(_dir, "nope")));

    [Fact]
    public void Production_hosts_start_tagged_prod_and_open_with_ssh()
    {
        File.WriteAllText(Path.Combine(_dir, "config"), "Host api-prod\nHost product-site\nHost db\n  HostName db.production.example\n");

        var profiles = SessionProfiles.SshHosts(Path.Combine(_dir, "config"), []).ToList();
        if (profiles.Count == 0)
        {
            return; // no ssh.exe on this machine: the provider rightly lists nothing
        }

        Assert.Equal(["prod"], profiles.Single(p => p.Name == "api-prod").Tags);
        Assert.Null(profiles.Single(p => p.Name == "product-site").Tags);
        Assert.Equal(["prod"], profiles.Single(p => p.Name == "db").Tags);
        Assert.Equal("ssh.exe api-prod", profiles[0].CommandLine);
        Assert.All(profiles, p => Assert.Equal(ProfileSources.Ssh, p.Source));
    }

    // ---- Custom profiles ----

    [Fact]
    public void Custom_profiles_are_cleaned_up_when_settings_load()
    {
        var settings = new AppSettings
        {
            Shells = new()
            {
                Profiles =
                [
                    new CustomProfile("custom-1", "  API  ", " npm run dev ", "  ", new Dictionary<string, string> { ["NODE_ENV"] = "dev", ["BAD=NAME"] = "x" }, [" prod ", "", "prod"], "nonsense"),
                    new CustomProfile("custom-1", "Duplicate id", "cmd.exe"),
                    new CustomProfile("custom-2", "", "cmd.exe"),
                    new CustomProfile("custom-3", "No command", " "),
                ],
            },
        }.Normalize();

        var profile = Assert.Single(settings.Shells.Profiles!);
        Assert.Equal("API", profile.Name);
        Assert.Equal("npm run dev", profile.CommandLine);
        Assert.Null(profile.WorkingDirectory);
        Assert.Equal(["NODE_ENV"], profile.Environment!.Keys);
        Assert.Equal(["prod"], profile.Tags);
        Assert.Equal("custom", profile.Icon);
    }

    [Fact]
    public void Custom_profiles_come_after_the_detected_shells_and_keep_their_settings()
    {
        var settings = new AppSettings { Shells = new() { Profiles = [new CustomProfile("custom-x", "Tests", "cmd.exe /k npm test", @"C:\dev", new Dictionary<string, string> { ["CI"] = "1" }, ["dev"])] } };

        var profiles = SessionProfiles.Detect(settings, Path.Combine(_dir, "no-ssh-config"));

        var custom = profiles.Single(p => p.Source == ProfileSources.Custom);
        Assert.True(profiles.ToList().IndexOf(custom) > profiles.ToList().FindLastIndex(p => p.Source == ProfileSources.Local));
        Assert.Equal(@"C:\dev", custom.WorkingDirectory);
        Assert.Equal("1", custom.Environment!["CI"]);
        Assert.Equal(["dev"], custom.Tags);
    }

    // ---- What every terminal starts with ----

    [Fact]
    public void Terminals_identify_as_termilly_and_unlock_progress_reports()
    {
        var shell = new SessionProfile("pwsh", "PowerShell", "", "powershell", "pwsh.exe", ProfileSources.Local);
        var vars = SessionLaunch.EnvironmentFor(shell, "1.2.3");

        Assert.Equal("ON", vars["ConEmuANSI"]);          // Claude Code sends OSC 9;4 only to terminals it knows
        Assert.Equal("Termilly", vars["TERM_PROGRAM"]);
        Assert.Equal("1.2.3", vars["TERM_PROGRAM_VERSION"]);
        Assert.Equal("", vars["WT_SESSION"]);             // empty removes it: an inherited one would be wrong here
        Assert.Equal("", vars["WT_PROFILE_ID"]);
    }

    [Fact]
    public void A_profiles_own_variables_win()
    {
        var custom = new SessionProfile("c", "Custom", "", "custom", "cmd.exe", ProfileSources.Custom,
            Environment: new Dictionary<string, string> { ["conemuansi"] = "OFF", ["NODE_ENV"] = "dev" });
        var vars = SessionLaunch.EnvironmentFor(custom, null);

        Assert.Equal("OFF", vars["ConEmuANSI"]);
        Assert.Equal("dev", vars["NODE_ENV"]);
    }

    // ---- Appearance settings ----

    [Theory]
    [InlineData("grayscale", "grayscale")]
    [InlineData("cleartype", "cleartype")]
    [InlineData("subpixel", "grayscale")]
    public void Text_smoothing_falls_back_to_greyscale(string stored, string expected) =>
        Assert.Equal(expected, new AppSettings { Terminal = new() { TextSmoothing = stored } }.Normalize().Terminal.TextSmoothing);

    [Theory]
    [InlineData(null, null)]
    [InlineData("   ", null)]
    [InlineData(" Inter ", "Inter")]
    public void App_font_is_trimmed_and_blank_means_the_windows_default(string? stored, string? expected) =>
        Assert.Equal(expected, new AppSettings { Interface = new() { Font = stored } }.Normalize().Interface.Font);

    [Fact]
    public void Installed_fonts_include_the_monospace_ones()
    {
        var (all, monospace, realBold) = new WindowsFonts().Read();
        Assert.NotEmpty(monospace);
        Assert.All(monospace, font => Assert.Contains(font, all));
        Assert.All(realBold, font => Assert.Contains(font, monospace));
        Assert.True(all.Count > monospace.Count);
        // Consolas ships with Windows with a bold file (consolab.ttf).
        if (monospace.Contains("Consolas"))
        {
            Assert.Contains("Consolas", realBold);
        }
    }

    [Fact]
    public void A_font_installed_without_its_bold_file_does_not_count_as_real_bold()
    {
        var (_, monospace, realBold) = new WindowsFonts().Read();
        // Only meaningful where Ubuntu Mono is installed as the regular file alone (as on the dev machine).
        string[] dirs =
        [
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Microsoft", "Windows", "Fonts"),
            Environment.GetFolderPath(Environment.SpecialFolder.Fonts),
        ];
        var files = dirs.Where(Directory.Exists).SelectMany(dir => Directory.GetFiles(dir, "UbuntuMono-*")).ToList();
        if (monospace.Contains("Ubuntu Mono") && files.All(f => f.EndsWith("-Regular.ttf", StringComparison.OrdinalIgnoreCase)))
        {
            Assert.DoesNotContain("Ubuntu Mono", realBold);
        }
    }

    // ---- Environment block ----

    [Fact]
    public void Environment_block_overrides_adds_and_removes_variables()
    {
        Environment.SetEnvironmentVariable("TERMILLY_TEST_KEEP", "kept");
        Environment.SetEnvironmentVariable("TERMILLY_TEST_DROP", "dropped");

        var block = EnvironmentBlock.Build(new Dictionary<string, string>
        {
            ["termilly_test_keep"] = "changed", // names match without regard to case
            ["TERMILLY_TEST_NEW"] = "a=b",
            ["TERMILLY_TEST_DROP"] = "",
        });
        var vars = block.TrimEnd('\0').Split('\0');

        Assert.EndsWith("\0\0", block);
        Assert.Contains("TERMILLY_TEST_KEEP=changed", vars);
        Assert.Contains("TERMILLY_TEST_NEW=a=b", vars);
        Assert.DoesNotContain(vars, v => v.StartsWith("TERMILLY_TEST_DROP", StringComparison.OrdinalIgnoreCase));
        Assert.Single(vars, v => v.StartsWith("TERMILLY_TEST_KEEP", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(vars.OrderBy(v => v.Split('=')[0], StringComparer.OrdinalIgnoreCase), vars);
    }

    // ---- Shell integration ----

    [Fact]
    public void PowerShell_loads_the_integration_script_after_the_users_profile()
    {
        var script = Path.Combine(_dir, "it's", "termilly.ps1");
        Directory.CreateDirectory(Path.GetDirectoryName(script)!);
        File.WriteAllText(script, "");
        var pwsh = new SessionProfile("pwsh", "PowerShell", "", "powershell", "pwsh.exe -NoLogo", ProfileSources.Local);

        var (commandLine, vars) = SessionLaunch.WithShellIntegration(pwsh, new Dictionary<string, string>(), script);

        Assert.Equal($"pwsh.exe -NoLogo -NoExit -Command \". ([scriptblock]::Create([IO.File]::ReadAllText('{script.Replace("'", "''")}')))\"", commandLine);
        Assert.Equal("1", vars["TERMILLY_SHELL_INTEGRATION"]);
    }

    [Fact]
    public void The_integration_script_loads_where_running_scripts_is_disabled()
    {
        // A clean Windows: the Restricted policy refuses every .ps1 file, the integration has to load anyway.
        var script = Path.Combine(_dir, "it's", "termilly.ps1");
        Directory.CreateDirectory(Path.GetDirectoryName(script)!);
        File.WriteAllText(script, "function global:Get-TermillyLoaded { 'loaded' }");
        var start = new System.Diagnostics.ProcessStartInfo("powershell.exe")
        {
            ArgumentList = { "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Restricted", "-Command",
                $"{SessionLaunch.PowerShellIntegrationCommand(script)}; Get-TermillyLoaded" },
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        using var process = System.Diagnostics.Process.Start(start)!;
        var output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
        process.WaitForExit();

        Assert.Equal("loaded", output.Trim());
    }

    [Fact]
    public void Bash_gets_its_marks_through_the_environment_and_wsl_passes_them_on()
    {
        var bash = new SessionProfile("git-bash", "Git Bash", "", "bash", "bash.exe --login -i", ProfileSources.Local);
        var (commandLine, vars) = SessionLaunch.WithShellIntegration(bash, new Dictionary<string, string>());
        Assert.Equal("bash.exe --login -i", commandLine);
        Assert.Contains("133;C", vars["PS0"]);
        Assert.Contains("633;E;%s", vars["PS0"]); // bash reports the command line itself
        Assert.Contains("133;D", vars["PROMPT_COMMAND"]);
        // Quiet where Termilly's own integration is installed (a WSL distribution set up), which reports them itself.
        Assert.StartsWith("""$([ -n "$__termilly_loaded" ] || printf '\e]633;E;%s\a\e]133;C\a' "$(HISTTIMEFORMAT=""", vars["PS0"]);
        Assert.Contains("""[ -n "$__termilly_loaded" ] || { """, vars["PROMPT_COMMAND"]);
        Assert.EndsWith("""printf '\033]133;D;%s\007\033]133;A\007' "$__termilly_status"; }""", vars["PROMPT_COMMAND"]);

        var wsl = new SessionProfile("wsl-ubuntu", "Ubuntu", "", "wsl", "wsl.exe -d Ubuntu", ProfileSources.Wsl);
        var (_, wslVars) = SessionLaunch.WithShellIntegration(wsl, new Dictionary<string, string> { ["WSLENV"] = "FOO/p:PS0/u" });
        Assert.Equal("FOO/p:PS0/u:PROMPT_COMMAND/u", wslVars["WSLENV"]);
    }

    [Fact]
    public void Every_terminal_tells_wsl_it_is_in_termilly()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        var powerShell = new SessionProfile("pwsh", "PowerShell", "", "powershell", "pwsh.exe", ProfileSources.Local);
        var vars = SessionLaunch.EnvironmentFor(powerShell, "0.1.0");
        Assert.Equal("1", vars[RemoteIntegration.Variable]);
        Assert.Contains($"{RemoteIntegration.Variable}/u", vars["WSLENV"].Split(':'));
    }

    [Theory]
    [InlineData(null, "LC_TERMILLY/u")]
    [InlineData("", "LC_TERMILLY/u")]
    [InlineData("USERPROFILE/p", "USERPROFILE/p:LC_TERMILLY/u")]
    [InlineData("LC_TERMILLY/u:FOO", "LC_TERMILLY/u:FOO")] // already there: not twice
    [InlineData("lc_termilly", "lc_termilly")] // names compare as Windows' do
    public void Wslenv_gets_each_variable_once(string? inherited, string expected) =>
        Assert.Equal(expected, SessionLaunch.WithWslVariables(inherited, "LC_TERMILLY/u"));

    [Fact]
    public void Cmd_custom_profiles_and_ssh_hosts_are_left_alone()
    {
        var vars = new Dictionary<string, string> { ["A"] = "1" };
        foreach (var profile in new[]
        {
            new SessionProfile("cmd", "Command Prompt", "", "cmd", "cmd.exe", ProfileSources.Local),
            new SessionProfile("custom-1", "Mine", "", "powershell", "powershell.exe -File x.ps1", ProfileSources.Custom),
            new SessionProfile("ssh-a", "a", "", "ssh", "ssh.exe a", ProfileSources.Ssh),
        })
        {
            var (commandLine, result) = SessionLaunch.WithShellIntegration(profile, vars);
            Assert.Equal(profile.CommandLine, commandLine);
            Assert.Same(vars, result);
        }
    }

    [Fact]
    public void Drop_down_settings_fall_back_to_offered_values()
    {
        var odd = new AppSettings { Quake = new() { Chord = "J", Height = 42, Workspace = "other" } }.Normalize();
        Assert.Equal(("Win+`", 50, "last"), (odd.Quake.Chord, odd.Quake.Height, odd.Quake.Workspace));
        Assert.All(SettingValues.Quake.Chords, chord => Assert.True(GlobalHotkeys.TryParse(chord, out _, out _), chord));
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(5000, 5000)]
    [InlineData(1000, 1000)]
    [InlineData(42, 0)]
    public void Hidden_scrollback_is_one_of_the_offered_budgets(int stored, int expected) =>
        Assert.Equal(expected, new AppSettings { Session = new() { HiddenScrollback = stored } }.Normalize().Session.HiddenScrollback);

    [Fact]
    public void Triggers_are_cleaned_up_when_settings_load()
    {
        var settings = new AppSettings
        {
            Commands = new()
            {
                Triggers =
                [
                    new TriggerSetting("a", "error", Action: "explode", Scope: "nowhere", Color: "red"),
                    new TriggerSetting("a", "duplicate id"),
                    new TriggerSetting("b", "  "),
                    new TriggerSetting("c", new string('x', 500), Action: "capture", Scope: "tag:prod"),
                ],
            },
        }.Normalize();

        Assert.Equal(["a", "c"], settings.Commands.Triggers!.Select(t => t.Id));
        Assert.Equal(("highlight", "all", (string?)null), (settings.Commands.Triggers![0].Action, settings.Commands.Triggers[0].Scope, settings.Commands.Triggers[0].Color));
        Assert.Equal((300, "capture", "tag:prod"), (settings.Commands.Triggers![1].Pattern.Length, settings.Commands.Triggers[1].Action, settings.Commands.Triggers[1].Scope));
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(4, 4)]
    [InlineData(5, 12)]
    public void Live_agent_limit_is_one_of_the_offered_values(int stored, int expected) =>
        Assert.Equal(expected, new AppSettings { Agents = new() { Limit = stored } }.Normalize().Agents.Limit);
}
