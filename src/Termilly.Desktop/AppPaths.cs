using System.IO;

namespace Termilly.Desktop;

/// <summary>The folder a terminal starts in, and whether the one asked for was missing.</summary>
internal readonly record struct ChosenFolder(string Folder, bool Missing);

internal static class AppPaths
{
    /// <summary>What a file being written is called until it's swapped in.</summary>
    private const string TempExtension = ".tmp";
    private const string LogsFolderName = "logs";
    private const string RecordingsFolderName = "recordings";

    /// <summary>%LOCALAPPDATA%\Termilly: settings, workspaces, session history and the WebView profile (see <see cref="DataFolder"/>).</summary>
    public static string DataDirectory => DataFolder.Path;

    /// <summary>Documents\Termilly: where logs and recordings go unless Settings say otherwise.</summary>
    public static string DocumentsFolder => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), Product.Name);

    /// <summary>Documents\Termilly\logs: terminal logs and serial console logs.</summary>
    public static string LogsFolder => Path.Combine(DocumentsFolder, LogsFolderName);

    /// <summary>Documents\Termilly\recordings.</summary>
    public static string RecordingsFolder => Path.Combine(DocumentsFolder, RecordingsFolderName);

    /// <summary>The page's files, next to the app.</summary>
    public static string WebRoot { get; } = Path.Combine(AppContext.BaseDirectory, "wwwroot");

    /// <summary>The window's and notifications' images, next to the app.</summary>
    public static string Assets { get; } = Path.Combine(AppContext.BaseDirectory, "Assets");

    /// <summary>Termilly's icon on Windows, every size it's shown at (the window, the tray), each drawn on whole pixels.</summary>
    public static string IconFile { get; } = Path.Combine(Assets, "termilly.ico");

    /// <summary>Shell integration's scripts (PowerShell's, and those for servers), next to the app.</summary>
    public static string ShellScripts { get; } = Path.Combine(AppContext.BaseDirectory, "shell");

    /// <summary>A program's file name on this system: "ssh.exe" on Windows, "ssh" elsewhere.</summary>
    public static string Exe(string name) => OperatingSystem.IsWindows() ? name + ".exe" : name;

    /// <summary>Writes to a temp file and swaps it in, so a crash mid-write never leaves a truncated file.</summary>
    public static void WriteAtomically(string path, string contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + TempExtension;
        File.WriteAllText(temp, contents);
        File.Move(temp, path, overwrite: true);
    }

    /// <inheritdoc cref="WriteAtomically(string, string)"/>
    public static void WriteAtomically(string path, byte[] contents)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        var temp = path + TempExtension;
        File.WriteAllBytes(temp, contents);
        File.Move(temp, path, overwrite: true);
    }

    /// <summary>Resolves a start folder (environment variables and a leading ~ allowed), or the user profile.</summary>
    public static string ResolveWorkingDirectory(string? requested)
    {
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        if (string.IsNullOrWhiteSpace(requested))
        {
            return home;
        }

        var path = Expand(requested);
        return Directory.Exists(path) ? path : home;
    }

    /// <summary>
    /// The folder a shell starts in: <paramref name="requested"/>, else <paramref name="fallback"/>, else the home folder.
    /// <c>Missing</c> when a folder was asked for and isn't there (deleted or renamed since).
    /// </summary>
    public static ChosenFolder StartFolder(string? requested, string? fallback)
    {
        if (string.IsNullOrWhiteSpace(requested) || Directory.Exists(Expand(requested)))
        {
            return new(ResolveWorkingDirectory(requested), false);
        }
        return new(ResolveWorkingDirectory(fallback), true);
    }

    /// <summary>A folder as typed: environment variables expanded, a leading ~ as the home folder.</summary>
    private static string Expand(string requested)
    {
        var path = Environment.ExpandEnvironmentVariables(requested.Trim());
        return path == "~" || path.StartsWith("~/", StringComparison.Ordinal) || path.StartsWith("~\\", StringComparison.Ordinal)
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + path[1..]
            : path;
    }
}
