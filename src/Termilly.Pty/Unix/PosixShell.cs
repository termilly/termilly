namespace Termilly.Pty.Unix;

/// <summary>What a POSIX shell (sh, bash, zsh) is given on its command line.</summary>
public static class PosixShell
{
    /// <summary>Runs the command that follows instead of reading commands.</summary>
    public const string CommandOption = "-c";
}
