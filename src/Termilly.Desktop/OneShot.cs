using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// The command line that runs one command in a shell of a profile and ends with that command's exit code. Terminals start
/// shells that stay (<see cref="SessionLaunch"/>); a schedule's hidden shell has nobody to stay for, and its process's exit
/// code is what says whether it worked, on every shell, cmd included. The shell still reads the user's startup files, so
/// the command finds what it would find in a terminal.
/// </summary>
internal static class OneShot
{
    private const string ShellCommandOption = "-c";
    /// <summary>cmd takes its command on one line; lines of a snippet run one after the other, as if typed.</summary>
    private const string CmdLineBreak = " & ";
    /// <summary>What ssh waits for a server before it gives up, in seconds.</summary>
    private const int SshConnectSeconds = 10;

    /// <summary>
    /// PowerShell's -Command ends with 0 or 1, whatever a program in it ended with: this passes the program's code on.
    /// </summary>
    private const string PowerShellExit = "\nif (-not $?) { if ($LASTEXITCODE) { exit $LASTEXITCODE }; exit 1 }";

    /// <summary>Whether a profile can run a command out of sight; custom profiles run whatever they run, so no.</summary>
    public static bool Supports(SessionProfile profile) => profile.Source switch
    {
        ProfileSources.Local => profile.Shell is ProfileIcons.PowerShell or ProfileIcons.Bash or ProfileIcons.Cmd,
        ProfileSources.Wsl or ProfileSources.Ssh => true,
        _ => false,
    };

    /// <param name="serverFolder">For a server's profile, the folder there to run it in.</param>
    public static string CommandLine(SessionProfile profile, string command, string? serverFolder = null) => profile.Source switch
    {
        ProfileSources.Ssh => Ssh(profile, string.IsNullOrEmpty(serverFolder) ? command : $"cd {SshGitRunner.Quote(serverFolder)} && {command}"),
        ProfileSources.Wsl => $"{profile.CommandLine} -e bash -l {ShellCommandOption} {Argument(command)}",
        _ when profile.Shell == ProfileIcons.PowerShell => $"{profile.CommandLine} -NoLogo -NonInteractive -EncodedCommand {Encoded(command + PowerShellExit)}",
        _ when profile.Shell == ProfileIcons.Cmd => $"{profile.CommandLine} /s /c \"{string.Join(CmdLineBreak, Lines(command))}\"",
        _ => $"{profile.CommandLine} {ShellCommandOption} {Argument(command)}",
    };

    /// <summary>
    /// With no way to answer: a host key not seen before or a password fails at once rather than waiting unseen. A connection
    /// with a saved password has its helper (<see cref="SshConnections"/>), which needs ssh to ask.
    /// </summary>
    private static string Ssh(SessionProfile profile, string remoteCommand)
    {
        var batch = profile.Environment?.ContainsKey(SshConnections.AskPassProgram) == true ? "" : " -o BatchMode=yes";
        var connection = profile.CommandLine[SessionProfiles.SshCommand.Length..].TrimStart();
        return $"{SessionProfiles.SshCommand} -T -o ConnectTimeout={SshConnectSeconds}{batch} {connection} {Argument(remoteCommand)}";
    }

    private static string Encoded(string script) => Convert.ToBase64String(Encoding.Unicode.GetBytes(script));

    private static string[] Lines(string command) =>
        command.Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);

    /// <summary>One argument, as this system's command line splits it (<see cref="Termilly.Pty.Unix.CommandLine"/> off Windows).</summary>
    private static string Argument(string word) => OperatingSystem.IsWindows() ? SshGitRunner.QuoteArgument(word) : SshGitRunner.Quote(word);
}
