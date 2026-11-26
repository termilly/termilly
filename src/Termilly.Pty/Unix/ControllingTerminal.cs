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

    /// <summary>
    /// bash counts itself as a shell level (SHLVL) for what it starts: one less, so the program counts as it would
    /// started directly. Then it becomes the program, its arguments as they were.
    /// </summary>
    private const string Script = "export SHLVL=$((${SHLVL:-1}-1)); exec \"$@\"";

    /// <summary>The name bash gives itself ($0) for the moment it runs.</summary>
    private const string Name = "termilly";

    /// <summary>
    /// The program's arguments as started: through bash on macOS, when there's a bash and the program can be found (one
    /// that can't is left to fail to start as it would, not run bash to say so); as they are elsewhere.
    /// </summary>
    /// <param name="environment">The program's environment, NAME=value: where its PATH is.</param>
    public static List<string> Arguments(List<string> argv, IReadOnlyList<string> environment, bool mac, Func<string, bool> exists)
    {
        if (!mac || !exists(Bash) || !Found(argv[0], environment, exists))
        {
            return argv;
        }
        return [Bash, "-c", Script, Name, .. argv];
    }

    /// <summary>Whether the program is there: a path that exists, or a name on the PATH.</summary>
    private static bool Found(string program, IReadOnlyList<string> environment, Func<string, bool> exists)
    {
        if (program.Contains('/', StringComparison.Ordinal))
        {
            return exists(program);
        }
        var path = environment.FirstOrDefault(v => v.StartsWith("PATH=", StringComparison.Ordinal))?["PATH=".Length..] ?? "";
        return path.Split(':', StringSplitOptions.RemoveEmptyEntries).Any(dir => exists($"{dir.TrimEnd('/')}/{program}"));
    }
}
