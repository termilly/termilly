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
        /// <summary>Tells shell\termilly.ps1 to load: without it the script does nothing.</summary>
        public const string ShellIntegration = "TERMILLY_SHELL_INTEGRATION";
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

        /// <summary>
        /// bash before 4.4 (macOS's own is 3.2) has no PS0: the first prompt sets a DEBUG trap instead (unless the
        /// user has one), which sends what PS0 would before the first command after each prompt. Each prompt sets
        /// __termilly_ready, and the trap skips the prompt's own first command, so an empty Enter marks nothing.
        /// </summary>
        public const string OldBashPreexec =
            """[ -n "$__termilly_trap" ] || { __termilly_trap=1; [ "$((BASH_VERSINFO[0] * 100 + BASH_VERSINFO[1]))" -lt 404 ] && [ -z "$(trap -p DEBUG)" ] && trap 'if [ -n "$__termilly_ready" ]; then __termilly_ready=; [ "${BASH_COMMAND#__termilly_status=}" = "$BASH_COMMAND" ] && printf "\033]633;E;%s\007\033]133;C\007" "$(HISTTIMEFORMAT= history 1 | sed "s/^ *[0-9]* *//")"; fi' DEBUG; }; __termilly_ready=1""";
    }

    /// <summary>cmd's prompt variable and what it shows when nobody set it (<see cref="CmdPrompt"/>).</summary>
    private static class CmdMarks
    {
        public const string Prompt = "PROMPT";
        public const string Default = "$P$G";
        /// <summary>The PowerShells that, typed at cmd's prompt, start with Termilly's integration (<see cref="CmdWithPowerShell"/>).</summary>
        public static readonly string[] PowerShells = ["powershell", "pwsh"];
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
    /// environment, unless the user's own startup files set them. cmd has no hooks, but its PROMPT can print the
    /// marks around the prompt it shows (<see cref="CmdPrompt"/>), and a PowerShell started from it loads the script
    /// too (<see cref="CmdWithPowerShell"/>). Custom profiles and SSH hosts run whatever they run, so they're left as
    /// they are.
    /// </summary>
    public static (string CommandLine, IReadOnlyDictionary<string, string> Environment) WithShellIntegration(
        SessionProfile profile, IReadOnlyDictionary<string, string> vars, string? script = null)
    {
        script ??= PowerShellIntegrationScript;
        var withMarks = new Dictionary<string, string>(vars, StringComparer.OrdinalIgnoreCase);
        switch (profile.Source, profile.Shell)
        {
            case (ProfileSources.Local, ProfileIcons.PowerShell) when File.Exists(script):
                withMarks[Variables.ShellIntegration] = "1";
                // The script's text runs as a script block rather than as a file: execution policy covers only
                // script files, so this works on a clean Windows (Restricted) without loosening the user's policy.
                return ($"{profile.CommandLine} -NoExit -Command \"{PowerShellIntegrationCommand(script)}\"", withMarks);
            case (ProfileSources.Local, ProfileIcons.Bash) when profile.Id == ZshMarks.Shell && Directory.Exists(ZshFolder):
                AddZshMarks(withMarks, vars);
                return (profile.CommandLine, withMarks);
            case (ProfileSources.Local, ProfileIcons.Bash) when profile.Id is TcshMarks.Tcsh or TcshMarks.Csh && Directory.Exists(TcshFolder):
                AddTcshMarks(withMarks, vars);
                return (profile.CommandLine, withMarks);
            case (ProfileSources.Local, ProfileIcons.Bash) when profile.Id == KshMarks.Shell && File.Exists(KshScript):
                AddKshMarks(withMarks, vars);
                return (profile.CommandLine, withMarks);
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
            case (ProfileSources.Local, ProfileIcons.Cmd):
                withMarks[CmdMarks.Prompt] = CmdPrompt(vars.TryGetValue(CmdMarks.Prompt, out var prompt) ? prompt : System.Environment.GetEnvironmentVariable(CmdMarks.Prompt));
                if (!File.Exists(script))
                {
                    return (profile.CommandLine, withMarks);
                }
                withMarks[Variables.ShellIntegration] = "1";
                return (CmdWithPowerShell(profile.CommandLine, script), withMarks);
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
                                 @"printf '\033]133;D;%s\007\033]133;A\007' ""$__termilly_status""; }; " +
                                 BashMarks.OldBashPreexec;
    }

    /// <summary>
    /// zsh reads neither PS0 nor PROMPT_COMMAND: it starts with ZDOTDIR at shell/zsh, whose startup files read the
    /// user's own (from their ZDOTDIR, else ~) and then shell/termilly.zsh, which marks prompts and commands as
    /// <see cref="AddBashMarks"/> does. The user's ZDOTDIR is theirs again once the startup files have run.
    /// </summary>
    private static void AddZshMarks(Dictionary<string, string> withMarks, IReadOnlyDictionary<string, string> vars)
    {
        var own = vars.TryGetValue(ZshMarks.ZDotDir, out var set) ? set : System.Environment.GetEnvironmentVariable(ZshMarks.ZDotDir);
        if (!string.IsNullOrEmpty(own))
        {
            withMarks[ZshMarks.UserZDotDir] = own;
        }
        withMarks[ZshMarks.ZDotDir] = ZshFolder;
    }

    /// <summary>The variables zsh's startup files go by (<see cref="AddZshMarks"/>).</summary>
    private static class ZshMarks
    {
        public const string ZDotDir = "ZDOTDIR";
        public const string UserZDotDir = "TERMILLY_USER_ZDOTDIR";
        /// <summary>zsh's profile id (SessionProfiles.UnixShells names a shell's profile after its file).</summary>
        public const string Shell = "zsh";
    }

    /// <summary>
    /// tcsh (and csh, tcsh on macOS) reads no startup file a variable could name: it starts with HOME at shell/tcsh,
    /// whose .tcshrc puts the user's HOME back, reads their .tcshrc (or .cshrc) and then shell/termilly.tcsh, which
    /// marks prompts and commands as <see cref="AddBashMarks"/> does. The files read after .tcshrc (.history, .login)
    /// come from the user's home. Without a HOME to go back to, tcsh starts as it is.
    /// </summary>
    private static void AddTcshMarks(Dictionary<string, string> withMarks, IReadOnlyDictionary<string, string> vars)
    {
        var home = vars.TryGetValue(TcshMarks.Home, out var set) ? set : System.Environment.GetEnvironmentVariable(TcshMarks.Home);
        if (string.IsNullOrEmpty(home))
        {
            return;
        }
        withMarks[TcshMarks.UserHome] = home;
        withMarks[TcshMarks.Home] = TcshFolder;
    }

    /// <summary>
    /// ksh (ksh93) reads the file ENV names when it starts interactive: shell/termilly.ksh, which reads the user's own
    /// ENV file (or ~/.kshrc) and then marks prompts and commands as <see cref="AddBashMarks"/> does.
    /// </summary>
    private static void AddKshMarks(Dictionary<string, string> withMarks, IReadOnlyDictionary<string, string> vars)
    {
        var own = vars.TryGetValue(KshMarks.Env, out var set) ? set : System.Environment.GetEnvironmentVariable(KshMarks.Env);
        if (!string.IsNullOrEmpty(own))
        {
            withMarks[KshMarks.UserEnv] = own;
        }
        withMarks[KshMarks.Env] = KshScript;
    }

    /// <summary>The variables tcsh's start goes by (<see cref="AddTcshMarks"/>), and the profile ids it covers.</summary>
    private static class TcshMarks
    {
        public const string Home = "HOME";
        public const string UserHome = "TERMILLY_USER_HOME";
        public const string Tcsh = "tcsh";
        public const string Csh = "csh";
    }

    /// <summary>The variables ksh's start goes by (<see cref="AddKshMarks"/>), and its profile id.</summary>
    private static class KshMarks
    {
        public const string Env = "ENV";
        public const string UserEnv = "TERMILLY_USER_ENV";
        public const string Shell = "ksh";
    }

    /// <summary>tcsh's startup file for Termilly's terminals (see shell/tcsh), next to the app.</summary>
    internal static string TcshFolder { get; } = Path.Combine(AppPaths.ShellScripts, "tcsh");

    /// <summary>ksh's integration (shell/termilly.ksh), next to the app.</summary>
    internal static string KshScript { get; } = Path.Combine(AppPaths.ShellScripts, "termilly.ksh");

    /// <summary>zsh's startup files for Termilly's terminals (see shell/zsh), next to the app.</summary>
    internal static string ZshFolder { get; } = Path.Combine(AppPaths.ShellScripts, "zsh");

    /// <summary>
    /// cmd's PROMPT with the marks around <paramref name="own"/> (the user's PROMPT, or cmd's default): a prompt
    /// starts (A), and input starts (B). $e is Esc and $e\ ends each sequence. cmd can't run anything before a
    /// command or say how the last one ended, so there's no C or D: the host still sees its commands run.
    /// </summary>
    internal static string CmdPrompt(string? own) =>
        $@"$e]133;A$e\{(string.IsNullOrEmpty(own) ? CmdMarks.Default : own)}$e]133;B$e\";

    /// <summary>
    /// cmd's command line with a doskey macro for each of <see cref="CmdMarks.PowerShells"/>: typed on its own at the
    /// prompt, it starts with <paramref name="script"/> loaded, as a PowerShell terminal does, so its prompts are
    /// marked too (`snippet:` works there). With arguments (`powershell -c …`, a script) it runs as typed. In doskey
    /// $1 is the first argument and $* all of them; the brackets keep a quoted first argument from breaking the `if`.
    /// </summary>
    internal static string CmdWithPowerShell(string commandLine, string script) =>
        $"{commandLine} /k \"{string.Join(" & ", CmdMarks.PowerShells.Select(exe =>
            $"doskey {exe}=if [$1]==[] ({exe} -NoExit -Command \"{PowerShellIntegrationCommand(script)}\") else {exe} $*"))}\"";

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
