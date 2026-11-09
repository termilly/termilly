using System.Diagnostics;
using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// Starts a program an action names (Actions.cs), left to run on its own. A name is looked up on the PATH as a shell
/// would; on Windows a .cmd or .bat (VS Code's "code") runs through cmd, and a name that isn't on the PATH goes to the
/// shell, which also knows registered apps such as chrome or msedge.
/// </summary>
internal static class ProgramLauncher
{
    private const string Cmd = "cmd.exe";
    private const string PathVariable = "PATH";
    private const string PathExtVariable = "PATHEXT";
    private const string DefaultPathExt = ".COM;.EXE;.BAT;.CMD";
    private static readonly string[] BatchExtensions = [".cmd", ".bat"];
    /// <summary>What cmd expands or reads even inside double quotes; an argument with one can't be passed safely.</summary>
    private static readonly char[] UnsafeForCmd = ['"', '%', '!', '\r', '\n'];

    /// <summary>Starts it; ActionUnavailableException when it can't be found or its arguments can't go through cmd.</summary>
    public static void Start(string program, IReadOnlyList<string> arguments, string? folder)
    {
        var start = OperatingSystem.IsWindows() ? WindowsStart(program, arguments) : UnixStart(program, arguments);
        if (folder is not null && Directory.Exists(folder))
        {
            start.WorkingDirectory = folder;
        }
        try
        {
            Process.Start(start)?.Dispose();
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new ActionUnavailableException($"Couldn’t start {program}: {e.Message}");
        }
    }

    private static ProcessStartInfo WindowsStart(string program, IReadOnlyList<string> arguments)
    {
        var found = Find(program, (Environment.GetEnvironmentVariable(PathExtVariable) ?? DefaultPathExt).Split(';', StringSplitOptions.RemoveEmptyEntries));
        if (found is null)
        {
            // Not on the PATH: the shell may still know it (App Paths), or it's a document or folder.
            return new ProcessStartInfo(program, string.Join(' ', arguments.Select(SshGitRunner.QuoteArgument))) { UseShellExecute = true };
        }
        if (!BatchExtensions.Contains(Path.GetExtension(found), StringComparer.OrdinalIgnoreCase))
        {
            return WithArguments(new ProcessStartInfo(found) { UseShellExecute = false }, arguments);
        }
        if (arguments.Any(a => a.IndexOfAny(UnsafeForCmd) >= 0))
        {
            throw new ActionUnavailableException($"{Path.GetFileName(found)} runs through cmd, which can’t be given text with quotes, % or ! safely.");
        }
        // /s with the whole line in quotes: cmd takes what's between the outer quotes as it is.
        var line = string.Join(' ', [Quote(found), .. arguments.Select(Quote)]);
        return new ProcessStartInfo(Cmd, $"/d /v:off /s /c \"{line}\"") { UseShellExecute = false, CreateNoWindow = true };
    }

    private static ProcessStartInfo UnixStart(string program, IReadOnlyList<string> arguments) =>
        Find(program, [""]) is { } found
            ? WithArguments(new ProcessStartInfo(found) { UseShellExecute = false }, arguments)
            : throw new ActionUnavailableException($"{program} isn’t installed, or isn’t on PATH.");

    /// <summary>The program's full path: as given when it's a path, else the first match on the PATH.</summary>
    private static string? Find(string program, IReadOnlyList<string> extensions)
    {
        if (program.Contains(Path.DirectorySeparatorChar) || program.Contains(Path.AltDirectorySeparatorChar))
        {
            return File.Exists(program) ? Path.GetFullPath(program) : null;
        }
        var withExtension = Path.HasExtension(program) ? [""] : extensions;
        foreach (var dir in (Environment.GetEnvironmentVariable(PathVariable) ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var ext in withExtension)
            {
                try
                {
                    var candidate = Path.Combine(dir.Trim('"'), program + ext);
                    if (File.Exists(candidate))
                    {
                        return candidate;
                    }
                }
                catch (ArgumentException)
                {
                    // A PATH entry with characters a path can't have: skip it.
                }
            }
        }
        return null;
    }

    private static ProcessStartInfo WithArguments(ProcessStartInfo start, IReadOnlyList<string> arguments)
    {
        foreach (var argument in arguments)
        {
            start.ArgumentList.Add(argument);
        }
        return start;
    }

    private static string Quote(string text) => $"\"{text}\"";
}
