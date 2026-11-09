using System.Diagnostics;
using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// Off Windows a pipe is a socket file in the temp folder (.NET names it CoreFxPipe_ and the pipe's name), and a
/// Termilly that ends without closing it leaves the file behind. Each Termilly removes its own as it quits, and the
/// first one to start clears those nobody listens on any more. Nothing on Windows, where pipes are no files.
/// </summary>
internal static class PipeFiles
{
    /// <summary>What .NET puts before a pipe's name for its socket file.</summary>
    private const string FilePrefix = "CoreFxPipe_";
    /// <summary>Where Linux lists the sockets bound now, by path (the last field of each line).</summary>
    private const string BoundSockets = "/proc/net/unix";
    /// <summary>Which of its fields is the path (a socket with no path has one field less).</summary>
    private const int PathField = 7;

    /// <summary>A pipe's socket file.</summary>
    public static string PathOf(string pipeName) => Path.Combine(Path.GetTempPath(), FilePrefix + pipeName);

    /// <summary>Removes a pipe's socket file: its server has stopped.</summary>
    public static void Remove(string pipeName)
    {
        if (!OperatingSystem.IsWindows())
        {
            TryDelete(PathOf(pipeName));
        }
    }

    /// <summary>
    /// Removes Termilly's socket files that nothing listens on: on Linux, those the system lists no socket for; on
    /// macOS (no such list), a window's own whose process has ended.
    /// </summary>
    public static void ClearDead()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        string[] files;
        try
        {
            files = Directory.GetFiles(Path.GetTempPath(), FilePrefix + PipeNames.Prefix + "*");
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return;
        }
        var bound = OperatingSystem.IsLinux() ? BoundPaths() : null;
        foreach (var file in files)
        {
            if (bound is not null ? !bound.Contains(file) : WindowGone(file))
            {
                TryDelete(file);
            }
        }
    }

    /// <summary>The paths of the sockets bound now (Linux); null when the list can't be read (then as on macOS).</summary>
    private static HashSet<string>? BoundPaths()
    {
        try
        {
            return File.ReadLines(BoundSockets).Skip(1)
                .Select(line => line.Split(' ', StringSplitOptions.RemoveEmptyEntries))
                .Where(fields => fields.Length == PathField + 1)
                .Select(fields => fields[PathField])
                .ToHashSet(StringComparer.Ordinal);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Whether a window's own socket file (named by its process id) belongs to a process that has ended.</summary>
    private static bool WindowGone(string file)
    {
        var name = Path.GetFileName(file)[(FilePrefix.Length + PipeNames.Prefix.Length)..];
        if (!int.TryParse(name, out var pid))
        {
            return false; // the main or host pipe: can't tell here
        }
        try
        {
            using var process = Process.GetProcessById(pid);
            return false;
        }
        catch (ArgumentException)
        {
            return true;
        }
    }

    private static void TryDelete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            // gone already, or not ours: left as it is
        }
    }
}
