using System.IO;
using System.Runtime.InteropServices;

namespace Termilly.Shared;

/// <summary>A crash log About offers to show: its file and when it was last written (Unix milliseconds).</summary>
internal sealed record RecentCrash(string Path, long At);

/// <summary>
/// crash.log in the data folder: an error nothing caught, with its stack trace, written just before the program
/// ends, so a crash can be traced without the system's own logs (Linux has no Event Viewer). The app, the background
/// host and the helper each keep their own, so they never write over each other.
/// </summary>
internal static class CrashLog
{
    /// <summary>The app's log.</summary>
    public const string FileName = "crash.log";

    /// <summary>termilly-host's log.</summary>
    public const string HostFileName = "crash-host.log";

    /// <summary>The helper's (termilly, termilly-hook and the claude shim).</summary>
    public const string HelperFileName = "crash-helper.log";

    /// <summary>A log's previous one is named after it with this: crash.log is moved to crash.old.log once full.</summary>
    public const string OldExtension = ".old.log";

    private const long MaxBytes = 1024 * 1024;

    /// <summary>How long About offers a log after a crash was written to it.</summary>
    public static readonly TimeSpan RecentFor = TimeSpan.FromDays(7);

    private static readonly string[] FileNames = [FileName, HostFileName, HelperFileName];

    /// <summary>Where the log called <paramref name="fileName"/> goes.</summary>
    public static string PathOf(string fileName) => Path.Combine(DataFolder.Path, fileName);

    /// <summary>Writes every unhandled error to the log called <paramref name="fileName"/>. The program still ends after it, as it would anyway.</summary>
    public static void Install(string fileName = FileName) =>
        AppDomain.CurrentDomain.UnhandledException += (_, e) =>
        {
            if (e.ExceptionObject is Exception error)
            {
                Write(PathOf(fileName), error, DateTimeOffset.Now);
            }
        };

    /// <summary>Adds one crash to the log at <paramref name="path"/>. Never throws: the program is going down already.</summary>
    public static void Write(string path, Exception error, DateTimeOffset when)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            if (File.Exists(path) && new FileInfo(path).Length >= MaxBytes)
            {
                File.Move(path, Path.ChangeExtension(path, OldExtension), overwrite: true);
            }
            File.AppendAllText(path, Entry(error, when));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
        }
    }

    /// <summary>When, which build on which system, and the error.</summary>
    public static string Entry(Exception error, DateTimeOffset when) =>
        $"{when:yyyy-MM-dd HH:mm:ss zzz}  {Product.Name} {AppVersion.Current} on {RuntimeInformation.OSDescription}, .NET {Environment.Version}"
        + $"{Environment.NewLine}{error}{Environment.NewLine}{Environment.NewLine}";

    /// <summary>The logs in <paramref name="folder"/> written since <paramref name="since"/>, newest first.</summary>
    public static IReadOnlyList<RecentCrash> Recent(string folder, DateTimeOffset since) =>
        FileNames.Select(name => new FileInfo(Path.Combine(folder, name)))
            .Where(f => f.Exists && f.LastWriteTimeUtc >= since.UtcDateTime)
            .OrderByDescending(f => f.LastWriteTimeUtc)
            .Select(f => new RecentCrash(f.FullName, new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()))
            .ToList();
}

/// <summary>
/// %LOCALAPPDATA%\Termilly (~/.local/share/Termilly on Linux): settings, workspaces, session history, the WebView
/// profile and the crash logs. TERMILLY_DATA_DIR overrides it, so test runs don't touch a user's real data; the host
/// and the helper are started from the app or its terminals, so they inherit it.
/// </summary>
internal static class DataFolder
{
    public static string Path { get; } =
        Environment.GetEnvironmentVariable("TERMILLY_DATA_DIR") is { Length: > 0 } overridden
            ? overridden
            : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Product.Name);
}
