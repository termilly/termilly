using System.Diagnostics;
using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// The PATH a terminal's shell has on Linux and macOS, for finding programs the user installed (claude, codex). An app started
/// from the desktop gets the system's short PATH: on macOS only /usr/bin:/bin:/usr/sbin:/sbin, without ~/.local/bin, where
/// Claude Code's installer puts it, or Homebrew's and npm's folders. A terminal's shell reads the user's login files, which add
/// those, so the agent runs there and still wasn't offered. Here the login shell is asked for its PATH once, and the folders
/// installers use are added after it.
/// </summary>
internal static class LoginShellPath
{
    /// <summary>The user's login shell.</summary>
    private const string ShellVariable = "SHELL";
    private const string FallbackShell = "/bin/sh";
    /// <summary>Prints the environment, whatever the shell: its own syntax for a variable differs (fish, nu).</summary>
    private const string PrintEnvironment = "/usr/bin/env";
    private const string PathLine = SystemVariables.Path + "=";
    /// <summary>How long the login shell gets: a slow login file mustn't hold Termilly's start.</summary>
    private const int TimeoutMs = 3000;

    /// <summary>Where installers put programs for one user, under the home folder.</summary>
    private static readonly string[] HomeFolders = [".local/bin", ".claude/local", ".npm-global/bin", ".bun/bin", ".volta/bin", "bin"];
    /// <summary>Where package managers put them for everyone.</summary>
    private static readonly string[] SystemFolders = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin"];

    private static readonly Lazy<string> Found = new(() => Combine(
        Environment.GetEnvironmentVariable(SystemVariables.Path), AskShell(), Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));

    /// <summary>This process's PATH, then the login shell's, then the installers' folders; on Windows, this process's PATH.</summary>
    public static string Value => OperatingSystem.IsWindows() ? Environment.GetEnvironmentVariable(SystemVariables.Path) ?? "" : Found.Value;

    /// <summary>The folders to look in, each once, in order: this process's, the login shell's, the installers'.</summary>
    internal static string Combine(string? own, string? login, string home)
    {
        var known = HomeFolders.Select(folder => Path.Combine(home, folder)).Concat(SystemFolders);
        var folders = Split(own).Concat(Split(login)).Concat(string.IsNullOrEmpty(home) ? SystemFolders : known);
        return string.Join(Path.PathSeparator, folders.Distinct(StringComparer.Ordinal));
    }

    /// <summary>PATH's value in what env printed: its last PATH= line, as a login file may print before it.</summary>
    internal static string? PathIn(string environment) =>
        environment.Split('\n').Select(line => line.TrimEnd('\r')).LastOrDefault(line => line.StartsWith(PathLine, StringComparison.Ordinal))?[PathLine.Length..];

    private static string[] Split(string? path) =>
        (path ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    /// <summary>The login shell's PATH, or null when it can't say (no shell, an error, or too slow).</summary>
    private static string? AskShell()
    {
        var shell = Environment.GetEnvironmentVariable(ShellVariable);
        var start = new ProcessStartInfo(string.IsNullOrEmpty(shell) || !File.Exists(shell) ? FallbackShell : shell)
        {
            RedirectStandardOutput = true, RedirectStandardError = true, RedirectStandardInput = true, UseShellExecute = false, CreateNoWindow = true,
        };
        start.ArgumentList.Add("-l");
        start.ArgumentList.Add("-c");
        start.ArgumentList.Add(PrintEnvironment);
        try
        {
            using var process = Process.Start(start);
            if (process is null)
            {
                return null;
            }
            process.StandardInput.Close(); // nothing to read: a login file that asks gets the end of input
            process.ErrorDataReceived += (_, _) => { };
            process.BeginErrorReadLine();
            var output = process.StandardOutput.ReadToEndAsync();
            if (!output.Wait(TimeoutMs))
            {
                process.Kill(entireProcessTree: true);
                return null;
            }
            return PathIn(output.Result);
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException or IOException or AggregateException)
        {
            return null;
        }
    }
}
