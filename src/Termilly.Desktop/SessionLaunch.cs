using System.IO;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>
/// How a terminal of a profile starts: the variables it gets (Termilly's own, the agent hooks'), and the command line
/// with shell integration and, for SSH, keepalives. <see cref="SessionProfiles"/> finds the profiles.
/// </summary>
internal static class SessionLaunch
{
    /// <summary>Variables a terminal starts with, or that shell integration sets.</summary>
    private static class Variables
    {
        /// <summary>The variables WSL passes from Windows into the distribution.</summary>
        public const string WslEnv = "WSLENV";
        /// <summary>Off Windows, the agent folder, which bash's prompt puts back first on PATH.</summary>
        public const string AgentDir = "TERMILLY_AGENT_DIR";
    }

    /// <summary>The variables bash reads its prompt marks from (<see cref="AddBashMarks"/>).</summary>
    private static class BashMarks
    {
        public const string Ps0 = "PS0";
        public const string PromptCommand = "PROMPT_COMMAND";

        /// <summary>
        /// What the marks run behind: nothing when Termilly's integration installed in a WSL distribution
        /// (shell/remote/termilly.sh) has loaded, since it reports them itself.
        /// </summary>
        public const string Unless = """[ -n "$__termilly_loaded" ] ||""";
    }

    /// <summary>WSLENV's flag for a variable that goes from Windows into WSL only, as it is.</summary>
    private const string WslToLinux = "/u";

    /// <summary>
    /// WSLENV with <paramref name="added"/> after what it lists already (<paramref name="inherited"/>, from Windows or
    /// the profile), each variable once: names are separated by ':' and end at their flags ('/u').
    /// </summary>
    internal static string WithWslVariables(string? inherited, params string[] added)
    {
        var entries = (inherited ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries).ToList();
        static string NameOf(string entry) => entry.Split('/')[0];
        foreach (var entry in added)
        {
            if (!entries.Any(e => string.Equals(NameOf(e), NameOf(entry), StringComparison.OrdinalIgnoreCase)))
            {
                entries.Add(entry);
            }
        }
        return string.Join(':', entries);
    }

    /// <summary>
    /// Variables every terminal starts with, under the profile's own (which win):
    /// <list type="bullet">
    /// <item>ConEmuANSI=ON: apps that only send OSC 9;4 progress to terminals they know (Claude Code checks for
    /// ConEmu, where the sequence comes from) send it here too, and Termilly shows it as the busy spinner;</item>
    /// <item>TERM_PROGRAM / TERM_PROGRAM_VERSION name Termilly, replacing whatever terminal Termilly was started from;</item>
    /// <item>WT_SESSION / WT_PROFILE_ID are removed: inherited from a Windows Terminal that started Termilly, they'd
    /// claim a terminal these shells aren't in (and Claude Code turns progress off when it sees WT_SESSION).</item>
    /// <item>LC_TERMILLY=1 crosses ssh (SSH profiles send it, and Debian's and Ubuntu's ssh send LC_* anyway), so
    /// Termilly's integration on a server knows it's in Termilly (see <see cref="RemoteIntegration"/>). On Windows
    /// WSLENV passes it into WSL too, from every terminal: a WSL terminal, and `wsl` typed in PowerShell.</item>
    /// </list>
    /// </summary>
    public static IReadOnlyDictionary<string, string> EnvironmentFor(SessionProfile profile, string? version)
    {
        var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
        {
            ["ConEmuANSI"] = "ON",
            ["TERM_PROGRAM"] = Product.Name,
            ["TERM_PROGRAM_VERSION"] = version ?? "",
            [TerminalVariables.WindowsTerminalSession] = "",
            [TerminalVariables.WindowsTerminalProfile] = "",
            [RemoteIntegration.Variable] = "1",
        };
        if (OperatingSystem.IsWindows())
        {
            vars[Variables.WslEnv] = WithWslVariables(System.Environment.GetEnvironmentVariable(Variables.WslEnv), $"{RemoteIntegration.Variable}{WslToLinux}");
        }
        foreach (var (name, value) in profile.Environment ?? new Dictionary<string, string>())
        {
            vars[name] = value;
        }
        return vars;
    }

    /// <summary>
    /// Adds what a terminal needs to report agent events (see <see cref="AgentHooks"/>): its id, the window's pipe,
    /// the hooks file, and the agent folder first on PATH so `claude` finds the shim. The names are
    /// src/Shared's TerminalEnvironment. Off Windows the folder is also in TERMILLY_AGENT_DIR: a login shell's startup files
    /// put their own folders first (Ubuntu's ~/.profile adds ~/.local/bin, where Claude Code installs), so shell
    /// integration puts it back in front at each prompt.
    /// </summary>
    public static IReadOnlyDictionary<string, string> WithAgent(
        IReadOnlyDictionary<string, string> vars, string paneId, string pipeName, string settingsPath, string agentDirectory)
    {
        var path = vars.TryGetValue(SystemVariables.Path, out var own) ? own : System.Environment.GetEnvironmentVariable(SystemVariables.Path);
        var withAgent = new Dictionary<string, string>(vars, StringComparer.OrdinalIgnoreCase)
        {
            [TerminalEnvironment.PaneId] = paneId,
            [TerminalEnvironment.Pipe] = pipeName,
            [TerminalEnvironment.AgentSettings] = settingsPath,
            [TerminalEnvironment.AgentShim] = "", // inherited from a claude that started Termilly, it would turn the hooks off
            [SystemVariables.Path] = string.IsNullOrEmpty(path) ? agentDirectory : $"{agentDirectory}{Path.PathSeparator}{path}",
        };
        if (!OperatingSystem.IsWindows())
        {
            withAgent[Variables.AgentDir] = agentDirectory;
        }
        return withAgent;
    }

    /// <summary>Termilly's PowerShell script (see shell\termilly.ps1), copied next to the app.</summary>
    public static string PowerShellIntegrationScript { get; } = Path.Combine(AppPaths.ShellScripts, "termilly.ps1");

    /// <summary>The PowerShell that dot-sources <paramref name="script"/>'s text, so execution policy doesn't block it.</summary>
    public static string PowerShellIntegrationCommand(string script) =>
        $". ([scriptblock]::Create([IO.File]::ReadAllText('{script.Replace("'", "''")}')))";

    /// <summary>
    /// The command line and variables that make a detected shell mark its prompts and commands (OSC 133), so
    /// Termilly sees a command running even when it starts no process. PowerShell dot-sources shell\termilly.ps1
    /// after the user's profile; bash (Git Bash, and WSL through WSLENV) reads PS0 and PROMPT_COMMAND from the
    /// environment, unless the user's own startup files set them. cmd has no hooks, and custom profiles and SSH
    /// hosts run whatever they run, so they're left as they are.
    /// </summary>
    public static (string CommandLine, IReadOnlyDictionary<string, string> Environment) WithShellIntegration(
        SessionProfile profile, IReadOnlyDictionary<string, string> vars, string? script = null)
    {
        script ??= PowerShellIntegrationScript;
        var withMarks = new Dictionary<string, string>(vars, StringComparer.OrdinalIgnoreCase);
        switch (profile.Source, profile.Icon)
        {
            case (ProfileSources.Local, ProfileIcons.PowerShell) when File.Exists(script):
                withMarks["TERMILLY_SHELL_INTEGRATION"] = "1";
                // The script's text runs as a script block rather than as a file: execution policy covers only
                // script files, so this works on a clean Windows (Restricted) without loosening the user's policy.
                return ($"{profile.CommandLine} -NoExit -Command \"{PowerShellIntegrationCommand(script)}\"", withMarks);
            case (ProfileSources.Local, ProfileIcons.Bash):
                AddBashMarks(withMarks);
                if (!OperatingSystem.IsWindows() && File.Exists(script))
                {
                    // `pwsh` typed at bash's prompt gets PowerShell's integration too: an exported bash function (bash
                    // reads BASH_FUNC_name%% from its environment) starts it with the script. Only plain `pwsh`:
                    // scripts and `pwsh -c …` run as they are.
                    withMarks["TERMILLY_PWSH_SCRIPT"] = script;
                    withMarks["BASH_FUNC_pwsh%%"] =
                        """() { if [ $# -eq 0 ] && [ -f "$TERMILLY_PWSH_SCRIPT" ]; then TERMILLY_SHELL_INTEGRATION=1 command pwsh -NoExit -Command '. $env:TERMILLY_PWSH_SCRIPT'; else command pwsh "$@"; fi; }""";
                }
                return (profile.CommandLine, withMarks);
            case (ProfileSources.Wsl, _):
                AddBashMarks(withMarks);
                var inherited = vars.TryGetValue(Variables.WslEnv, out var own) ? own : System.Environment.GetEnvironmentVariable(Variables.WslEnv);
                withMarks[Variables.WslEnv] = WithWslVariables(inherited, $"{BashMarks.Ps0}{WslToLinux}", $"{BashMarks.PromptCommand}{WslToLinux}");
                return (profile.CommandLine, withMarks);
            default:
                return (profile.CommandLine, vars);
        }
    }

    /// <summary>
    /// The command line and variables a terminal of <paramref name="profile"/> starts with: shell integration, then
    /// for SSH the keepalives and the variable that tells Termilly's integration on the server it's in Termilly.
    /// Shell integration goes first, as it starts from the profile's own command line.
    /// </summary>
    public static (string CommandLine, IReadOnlyDictionary<string, string> Environment) Launch(
        SessionProfile profile, IReadOnlyDictionary<string, string> vars, AppSettings settings, string? script = null)
    {
        var (commandLine, environment) = settings.Shells.Integration ? WithShellIntegration(profile, vars, script) : (profile.CommandLine, vars);
        if (profile.Source == ProfileSources.Ssh && settings.Ssh.KeepAlive)
        {
            commandLine = WithKeepAlive(commandLine);
        }
        if (profile.Source == ProfileSources.Ssh && settings.Shells.Integration)
        {
            commandLine = RemoteIntegration.WithSendEnv(commandLine);
        }
        return (commandLine, environment);
    }

    /// <summary>
    /// bash: PS0 prints before each command runs (bash 4.4+), PROMPT_COMMAND before each prompt. bash can't mark
    /// where its prompt ends, so PS0 also reports the command line itself (OSC 633;E, as VS Code's integration does).
    /// PROMPT_COMMAND also keeps the agent folder first on PATH (see <see cref="WithAgent"/>; unset on Windows) and,
    /// off Windows, reports the working folder (OSC 7) for the page's recent folders and the terminal's cwd.
    /// In a WSL distribution set up for Termilly, its own integration (shell/remote/termilly.sh, which sets
    /// __termilly_loaded) reports all of this and the repository, so these marks step aside rather than come twice.
    /// </summary>
    private static void AddBashMarks(Dictionary<string, string> vars)
    {
        vars[BashMarks.Ps0] = $$"""$({{BashMarks.Unless}} printf '\e]633;E;%s\a\e]133;C\a' "$(HISTTIMEFORMAT= history 1 | sed 's/^ *[0-9]* *//')")""";
        vars[BashMarks.PromptCommand] = @"__termilly_status=$?; " +
                                 $$"""[[ -n "${{Variables.AgentDir}}" && "$PATH" != "${{Variables.AgentDir}}":* ]] && PATH="${{Variables.AgentDir}}:$PATH"; """ +
                                 $"{BashMarks.Unless} {{ " +
                                 (OperatingSystem.IsWindows() ? "" : @"printf '\033]7;file://%s%s\007' ""$HOSTNAME"" ""$PWD""; ") +
                                 @"printf '\033]133;D;%s\007\033]133;A\007' ""$__termilly_status""; }";
    }

    /// <summary>
    /// An ssh command line with server keepalives, so a dead connection is noticed in under a minute (and the
    /// terminal can reconnect) instead of hanging: every 15 s, giving up after 3 unanswered. Left alone when the
    /// command already sets them.
    /// </summary>
    internal static string WithKeepAlive(string commandLine)
    {
        var ssh = commandLine.StartsWith($"{SessionProfiles.SshCommand} ", StringComparison.OrdinalIgnoreCase) ? SessionProfiles.SshCommand : null;
        if (ssh is null || commandLine.Contains("ServerAliveInterval", StringComparison.OrdinalIgnoreCase))
        {
            return commandLine;
        }
        return $"{ssh} -o ServerAliveInterval=15 -o ServerAliveCountMax=3 {commandLine[(ssh.Length + 1)..]}";
    }
}
