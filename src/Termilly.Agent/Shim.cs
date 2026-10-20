using System.Diagnostics;

namespace Termilly.Agent;

/// <summary>
/// Runs as claude (claude.exe on Windows) from Termilly's agent folder, which terminals have first on PATH. Starts the real Claude Code
/// with Termilly's hooks added (--settings adds to the user's own hooks, it doesn't replace them) and passes its
/// exit code back. Outside Termilly, or for a claude started from inside a hooked one, it adds nothing.
/// </summary>
internal static class Shim
{
    /// <summary>The exit code cmd gives for a command it can't find.</summary>
    private const int CommandNotFound = 9009;

    public static int Run(string[] args)
    {
        var real = FindReal(
            Environment.GetEnvironmentVariable(SystemVariables.Path),
            Environment.GetEnvironmentVariable(SystemVariables.PathExt),
            AppContext.BaseDirectory);
        if (real is null)
        {
            Console.Error.WriteLine("claude: Claude Code isn't installed (no claude found on PATH besides Termilly's).");
            return CommandNotFound;
        }

        var start = new ProcessStartInfo(real) { UseShellExecute = false };
        var settings = Environment.GetEnvironmentVariable(Protocol.SettingsVariable);
        if (Environment.GetEnvironmentVariable(Protocol.ShimVariable) != "1" && File.Exists(settings))
        {
            start.ArgumentList.Add("--settings");
            start.ArgumentList.Add(settings);
            start.Environment[Protocol.ShimVariable] = "1";
        }
        foreach (var arg in args)
        {
            start.ArgumentList.Add(arg);
        }

        // Ctrl+C reaches every process in the console; Claude Code decides what it means, the shim just waits.
        Console.CancelKeyPress += (_, e) => e.Cancel = true;
        using var process = Process.Start(start)!;
        process.WaitForExit();
        return process.ExitCode;
    }

    /// <summary>
    /// The first claude on PATH that isn't this shim: each folder in PATH order, and on Windows each in PATHEXT order
    /// (claude.exe from the native installer, claude.cmd from npm). Elsewhere, the first executable file named claude.
    /// </summary>
    public static string? FindReal(string? path, string? pathExt, string shimDirectory)
    {
        var shim = Normalize(shimDirectory);
        var extensions = !OperatingSystem.IsWindows() ? [""] : (string.IsNullOrWhiteSpace(pathExt) ? ".COM;.EXE;.BAT;.CMD" : pathExt)
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Where(ext => ext is not (".ps1" or ".PS1")); // a script needs PowerShell to start it
        foreach (var directory in (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string full;
            try
            {
                full = Normalize(Environment.ExpandEnvironmentVariables(directory.Trim('"')));
            }
            catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
            {
                continue;
            }
            if (string.Equals(full, shim, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            foreach (var ext in extensions)
            {
                var candidate = Path.Combine(full, AgentExecutables.Claude + ext.ToLowerInvariant());
                if (File.Exists(candidate) && (OperatingSystem.IsWindows() || (File.GetUnixFileMode(candidate) & Executable) != 0))
                {
                    return candidate;
                }
            }
        }
        return null;
    }

    private const UnixFileMode Executable = UnixFileMode.UserExecute | UnixFileMode.GroupExecute | UnixFileMode.OtherExecute;

    private static string Normalize(string directory) =>
        Path.GetFullPath(directory).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
}
