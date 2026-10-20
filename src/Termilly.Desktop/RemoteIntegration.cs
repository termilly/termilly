using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>
/// Termilly's shell integration on a server reached over SSH (shell/remote): prompt marks, the folder, the repository
/// and Claude Code's hooks, reported through the terminal since nothing else crosses ssh. "Set up Termilly on this
/// host" types <see cref="InstallCommand"/> into the terminal, which reads <see cref="Installer"/> (base64, not echoed)
/// from it and runs it: so it works for any login (passwords, jump hosts, su) without a second connection.
/// </summary>
internal static partial class RemoteIntegration
{
    /// <summary>
    /// What tells the remote script it runs in a Termilly terminal. Every terminal gets it and SSH profiles pass it
    /// with SendEnv; Debian, Ubuntu and most servers accept LC_* (AcceptEnv), and their ssh clients send it too.
    /// </summary>
    public const string Variable = "LC_TERMILLY";

    /// <summary>The scripts, copied next to the app with the other shell integration.</summary>
    public static string ScriptFolder { get; } = Path.Combine(AppPaths.ShellScripts, RemoteFolder);
    /// <summary>The shell integration's scripts next to the app, and the remote ones among them.</summary>
    private const string RemoteFolder = "remote";
    /// <summary>The script a server's shells load, the hook that reports through the terminal, and the uninstaller.</summary>
    private const string MainScript = "termilly.sh";
    private const string HookScript = "termilly-hook.sh";
    private const string Uninstaller = "uninstall.sh";
    /// <summary>Claude Code's settings with Termilly's hooks, as installed in ~/.termilly.</summary>
    private const string ClaudeSettingsFile = "claude-settings.json";

    [GeneratedRegex(@"^TERMILLY_REMOTE_VERSION=(\d+)", RegexOptions.Multiline)]
    private static partial Regex VersionLine();

    /// <summary>The version of termilly.sh in <paramref name="folder"/> (it reports its own at the first prompt); 0 when missing.</summary>
    public static int VersionIn(string? folder = null)
    {
        var script = Path.Combine(folder ?? ScriptFolder, MainScript);
        return File.Exists(script) && VersionLine().Match(File.ReadAllText(script)) is { Success: true } m ? int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture) : 0;
    }

    /// <summary>
    /// The installer, a sh script: writes the scripts and Claude Code's hook settings into ~/.termilly, and adds the
    /// line that loads them to ~/.bashrc and ~/.zshrc (the ones the user has, or their login shell's).
    /// </summary>
    public static string Installer(string? folder = null)
    {
        folder ??= ScriptFolder;
        var text = new StringBuilder();
        text.Append("set -e\n");
        text.Append("d=\"$HOME/.termilly\"\n");
        text.Append("mkdir -p \"$d\"\n");
        void Add(string name, string contents)
        {
            // A quoted here-document: nothing in it is expanded. The scripts never contain the end word.
            text.Append(CultureInfo.InvariantCulture, $"cat > \"$d/{name}\" <<'TERMILLY_FILE_END'\n");
            text.Append(contents.Replace("\r\n", "\n").TrimEnd('\n')).Append('\n');
            text.Append("TERMILLY_FILE_END\n");
        }
        foreach (var name in new[] { MainScript, HookScript, Uninstaller })
        {
            Add(name, File.ReadAllText(Path.Combine(folder, name)));
        }
        Add(ClaudeSettingsFile, ClaudeHookSettings.ForRemote());
        text.Append("chmod +x \"$d/termilly-hook.sh\" \"$d/uninstall.sh\"\n");
        text.Append("""
            line='[ -f "$HOME/.termilly/termilly.sh" ] && . "$HOME/.termilly/termilly.sh"'
            for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
              case "$rc:${SHELL-}" in
                *.bashrc:*bash) ;;
                *.zshrc:*zsh) ;;
                *) [ -f "$rc" ] || continue ;;
              esac
              grep -q '\.termilly/termilly\.sh' "$rc" 2>/dev/null && continue
              [ -s "$rc" ] && [ -n "$(tail -c 1 "$rc")" ] && printf '\n' >> "$rc"
              printf '%s\n' "$line" >> "$rc"
            done
            printf 'Termilly is set up on this host.\n'

            """);
        // Unix line ends throughout, whatever this file was checked out with (the text above is part of it).
        return text.ToString().Replace("\r\n", "\n");
    }

    /// <summary>
    /// The line typed into the terminal to install: it turns echo and line editing off (so the installer isn't shown
    /// and isn't cut at the terminal's line limit), says it's ready (OSC 633;P;TermillyReady), reads
    /// <paramref name="length"/> characters of base64, then runs them and loads the integration into this shell.
    /// It starts with a space, which keeps it out of the shell's history (HISTCONTROL=ignorespace, zsh's
    /// HIST_IGNORE_SPACE), and works in bash, zsh and sh.
    /// </summary>
    public static string InstallCommand(int length) =>
        " __termilly_tty=$(stty -g); stty -echo -icanon min 1;"
        + " printf '\\033]633;P;TermillyReady\\007';"
        + $" head -c {length} | base64 -d > \"$HOME/.termilly-install.sh\"; stty \"$__termilly_tty\"; unset __termilly_tty;"
        + " sh \"$HOME/.termilly-install.sh\"; rm -f \"$HOME/.termilly-install.sh\";"
        + $" export {Variable}=1; [ -f \"$HOME/.termilly/termilly.sh\" ] && . \"$HOME/.termilly/termilly.sh\"";

    /// <summary>The installer as it's sent after <see cref="InstallCommand"/>: base64, on one line.</summary>
    public static string Payload(string? folder = null) => Convert.ToBase64String(Encoding.UTF8.GetBytes(Installer(folder)));

    /// <summary>The line typed into the terminal to take the integration off the host again.</summary>
    public const string RemoveCommand = " [ -f \"$HOME/.termilly/uninstall.sh\" ] && sh \"$HOME/.termilly/uninstall.sh\"";

    /// <summary>
    /// An ssh command line that passes <see cref="Variable"/> on (SendEnv), so the remote script knows it's in
    /// Termilly. Left alone when it isn't ssh or already sends it.
    /// </summary>
    public static string WithSendEnv(string commandLine)
    {
        var ssh = SessionProfiles.SshCommand;
        if (!commandLine.StartsWith($"{ssh} ", StringComparison.OrdinalIgnoreCase) || commandLine.Contains(Variable, StringComparison.Ordinal))
        {
            return commandLine;
        }
        return $"{ssh} -o SendEnv={Variable} {commandLine[(ssh.Length + 1)..]}";
    }
}
