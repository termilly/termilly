namespace Termilly.Pty.Unix;

/// <summary>
/// macOS: a program posix_spawn starts in a session of its own doesn't get the terminal it opens as its controlling
/// terminal (Linux's does). A shell without one never hears that the terminal was resized (SIGWINCH), nor gets Ctrl+C's
/// interrupt for what it runs: zsh keeps the width it started with, and so do Claude Code and the rest. bash takes the
/// terminal as it starts; so the program starts through it (<c>bash -c 'exec "$@"'</c>), and is then the same process,
/// the terminal its own.
/// </summary>
public static class ControllingTerminal
{
    /// <summary>The shell that takes the terminal on its way to the program: on every Mac.</summary>
    private const string Bash = "/bin/bash";

    /// <summary>Where BASH_ENV waits while bash starts.</summary>
    private const string HeldBashEnv = "TERMILLY_BASH_ENV";
    private const string BashEnv = "BASH_ENV=";

    /// <summary>
    /// What bash runs: BASH_ENV given back to the program (bash, not interactive, would run that file first, and it isn't
    /// bash's to run), then it becomes the program, by its full path, its arguments as they were. bash's exec counts
    /// SHLVL back down itself.
    /// </summary>
    private const string Script =
        "if [ -n \"${" + HeldBashEnv + "+x}\" ]; then export BASH_ENV=\"$" + HeldBashEnv + "\"; unset " + HeldBashEnv + "; fi; exec \"$@\"";

    /// <summary>The name bash gives itself ($0) for the moment it runs.</summary>
    private const string Name = "termilly";

    /// <summary>How a file is checked: whether it may be run.</summary>
    public sealed record Files(Func<string, bool> Executable);

    /// <summary>The program to start, its arguments and environment: through bash on macOS, or as they were.</summary>
    public sealed record Start(List<string> Argv, List<string> Environment);

    /// <summary>The system's own check: a file that's there with a permission to run it.</summary>
    public static readonly Files System = new(path => !OperatingSystem.IsWindows() && File.Exists(path)
        && (File.GetUnixFileMode(path) & (UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute)) != 0);

    /// <summary>
    /// How the program starts: on macOS through bash when there's one and the program is found as posix_spawnp would
    /// find it (the app's own PATH, or a path from the working directory) and may be run; as it is otherwise, so one that
    /// can't start fails to as before rather than bash saying so in the terminal.
    /// </summary>
    /// <param name="searchPath">The PATH posix_spawnp searches: this process's.</param>
    public static Start Of(List<string> argv, List<string> environment, string? workingDirectory, string? searchPath, bool mac, Files files)
    {
        if (!mac || !files.Executable(Bash) || Resolve(argv[0], workingDirectory, searchPath, files) is not { } program)
        {
            return new Start(argv, environment);
        }
        // BASH_ENV held aside for bash's start, given back before the program's.
        var held = environment.Select(v => v.StartsWith(BashEnv, StringComparison.Ordinal) ? $"{HeldBashEnv}={v[BashEnv.Length..]}" : v).ToList();
        return new Start([Bash, "-c", Script, Name, program, .. argv.Skip(1)], held);
    }

    /// <summary>The program's full path, found as posix_spawnp would; null when it isn't there or may not be run.</summary>
    private static string? Resolve(string program, string? workingDirectory, string? searchPath, Files files)
    {
        if (program.Contains('/', StringComparison.Ordinal))
        {
            var relative = program.StartsWith("./", StringComparison.Ordinal) ? program[2..] : program;
            var full = program.StartsWith('/') || string.IsNullOrEmpty(workingDirectory) ? program : $"{workingDirectory.TrimEnd('/')}/{relative}";
            return files.Executable(full) ? full : null;
        }
        return (searchPath ?? "").Split(':', StringSplitOptions.RemoveEmptyEntries)
            .Select(dir => $"{dir.TrimEnd('/')}/{program}")
            .FirstOrDefault(files.Executable);
    }
}
