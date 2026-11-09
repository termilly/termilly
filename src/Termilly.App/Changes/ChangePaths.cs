using System.IO;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A path as a terminal printed it, cleaned, and the line it named (file.ts:12).</summary>
internal readonly record struct PrintedPath(string Path, int? Line);

/// <summary>How a path is shown: relative to the terminal's folder when it's inside it, and whether it's outside.</summary>
internal readonly record struct ShownPath(string Display, bool Outside);

/// <summary>
/// Paths for the change preview, as the system has them: on Windows C:\dir\file, any case; on Linux /dir/file, case
/// matters, and a backslash is just a character in a name. What a printed path means, how it's shown, which folders
/// are too broad to watch, and which files never count.
/// </summary>
internal static partial class ChangePaths
{
    private static readonly bool Unix = !OperatingSystem.IsWindows();
    public static readonly char Separator = Path.DirectorySeparatorChar;
    public static readonly StringComparer Comparer = Unix ? StringComparer.Ordinal : StringComparer.OrdinalIgnoreCase;
    public static readonly StringComparison Comparison = Unix ? StringComparison.Ordinal : StringComparison.OrdinalIgnoreCase;

    /// <summary>The most files and folders read under one folder (a new folder's files, copies in subfolders).</summary>
    public const int MaxWalk = 5000;
    /// <summary>A Windows path to a drive's root: "C:\".</summary>
    private const int DriveRootLength = 3;
    private const string HomePrefix = "~/";
    private const string HomePrefixWindows = "~\\";

    /// <summary>
    /// Folders and files a command doesn't count for: tools' own output and caches, temporary files, and what Windows
    /// and shells keep changing in the user's profile (NTUSER.DAT and its logs, shell history).
    /// </summary>
    [GeneratedRegex(@"[\\/](\.git|\.vs|\.idea|\.claude|node_modules|bin|obj|\$Recycle\.Bin)[\\/]|(\.tmp|~|\.swp|\.lock)$|[\\/]ntuser\.[^\\/]*$|[\\/]\.[\w-]*(history|hst)$", RegexOptions.IgnoreCase)]
    public static partial Regex Ignored();

    [GeneratedRegex(@"^/([a-zA-Z])(?=/|$)/?")]
    private static partial Regex GitBashDrive();

    [GeneratedRegex(@":(\d+)(?::\d+)?$")]
    private static partial Regex LineSuffix();

    /// <summary>A folder without its trailing separator, except a root's own (C:\, /).</summary>
    public static string TrimFolder(string folder) =>
        folder.Length > 1 && Path.GetPathRoot(folder) != folder ? folder.TrimEnd(Separator) : folder;

    /// <summary>
    /// A path as the system writes it, full, with a relative path taken from <paramref name="cwd"/>. On Windows, Git
    /// Bash's /c/dir becomes C:\dir and slashes turn around; null for a path that isn't on this PC (/home/... from WSL
    /// or SSH). On Linux the path stays as it is.
    /// </summary>
    public static string? Normalize(string path, string? cwd)
    {
        path = path.Trim();
        if (path.Length == 0)
        {
            return null;
        }
        if (!Unix)
        {
            if (GitBashDrive().Match(path) is { Success: true } drive)
            {
                path = char.ToUpperInvariant(drive.Groups[1].Value[0]) + ":\\" + path[drive.Length..];
            }
            else if (path.StartsWith('/') && !path.StartsWith("//", StringComparison.Ordinal))
            {
                return null;
            }
            path = path.Replace('/', '\\');
        }
        try
        {
            if (!(Unix ? Path.IsPathRooted(path) : Path.IsPathFullyQualified(path)))
            {
                if (cwd is null || Normalize(cwd, null) is not { } folder)
                {
                    return null;
                }
                path = Path.Combine(folder, path);
            }
            return Path.GetFullPath(path);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null;
        }
    }

    /// <summary>A path as printed: quotes, :line:column and trailing punctuation removed (the line is kept).</summary>
    public static PrintedPath Clean(string text)
    {
        var path = text.Trim().TrimStart('"', '\'', '`', '(', '[', '<').TrimEnd('"', '\'', '`', ')', ']', '>', '.', ',', ';', ':');
        int? line = null;
        if (LineSuffix().Match(path) is { Success: true } m)
        {
            path = path[..m.Index];
            line = int.TryParse(m.Groups[1].Value, out var n) ? n : null;
        }
        return new(path, line);
    }

    /// <summary>A path printed in a terminal, as this system writes it, with a leading ~ meaning the home folder.</summary>
    public static string AsSystem(string clean) => Unix ? clean : clean.Replace('/', '\\');

    public static string ExpandHome(string clean) =>
        clean.StartsWith(HomePrefix, StringComparison.Ordinal) || clean.StartsWith(HomePrefixWindows, StringComparison.Ordinal)
            ? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), clean[HomePrefix.Length..])
            : clean;

    /// <summary>On Windows a /home/... path is on another machine (WSL, SSH); on Linux it's this one's.</summary>
    public static bool IsElsewhere(string clean) => !Unix && clean.StartsWith('/') && !GitBashDrive().IsMatch(clean);

    /// <summary>Why a path on another machine can't be previewed.</summary>
    public static string ElsewhereMessage => $"This file isn't on this {(Unix ? "machine (SSH)" : "PC (SSH or WSL)")}, so Termilly can't preview it.";

    /// <summary>A path relative to the terminal's folder when it's inside it; else the full path, and that it's outside.</summary>
    public static ShownPath Display(string path, string? cwd)
    {
        var folder = cwd is null ? null : Normalize(cwd, null) is { } full ? TrimFolder(full).TrimEnd(Separator) : null;
        return folder is not null && path.StartsWith(folder + Separator, Comparison)
            ? new(path[(folder.Length + 1)..], false)
            : new(path, folder is not null);
    }

    /// <summary>A path relative to a repository's root, as git writes it.</summary>
    public static string RelativeForGit(string root, string path) =>
        Unix ? Path.GetRelativePath(root, path) : Path.GetRelativePath(root.Replace('/', '\\'), path).Replace('\\', '/');

    /// <summary>
    /// Watching everything under it would be all noise: a drive's root, the user's profile, or Windows; on Linux the
    /// root, the home folder, or a folder right under the root (/home, /usr, /tmp...).
    /// </summary>
    public static bool IsBroad(string folder)
    {
        var trimmed = TrimFolder(folder);
        var home = TrimFolder(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile));
        if (Unix)
        {
            return trimmed == "/" || trimmed.LastIndexOf('/') == 0 || string.Equals(trimmed, home, Comparison);
        }
        return trimmed.Length <= DriveRootLength ||
               string.Equals(trimmed, home, Comparison) ||
               string.Equals(trimmed, TrimFolder(Environment.GetFolderPath(Environment.SpecialFolder.Windows)), Comparison);
    }

    /// <summary>
    /// The first folder of <paramref name="path"/> that doesn't exist, under the nearest one that does; null when the
    /// whole path exists (or is a file).
    /// </summary>
    public static string? NewRoot(string path)
    {
        string? missing = null;
        var folder = TrimFolder(path);
        while (!string.IsNullOrEmpty(folder) && !Directory.Exists(folder))
        {
            if (File.Exists(folder))
            {
                return null;
            }
            missing = folder;
            folder = Path.GetDirectoryName(folder);
        }
        return string.IsNullOrEmpty(folder) ? null : missing;
    }

    /// <summary>
    /// The files under a folder, nearest first, leaving out ignored folders (.git, node_modules, bin, obj...) without
    /// going into them. <paramref name="top"/>: include the files directly in it. At most <see cref="MaxWalk"/> entries.
    /// </summary>
    public static IEnumerable<FileInfo> FilesUnder(string root, bool top = true)
    {
        var start = new DirectoryInfo(root);
        var queue = new Queue<DirectoryInfo>([start]);
        var seen = 0;
        while (queue.Count > 0 && seen < MaxWalk)
        {
            var dir = queue.Dequeue();
            List<FileSystemInfo> entries;
            try
            {
                entries = dir.EnumerateFileSystemInfos().Take(MaxWalk - seen).ToList();
            }
            catch (Exception ex) when (Storage.IsFileError(ex))
            {
                continue;
            }
            seen += entries.Count;
            foreach (var entry in entries)
            {
                if (entry is DirectoryInfo sub)
                {
                    if (!sub.Attributes.HasFlag(FileAttributes.ReparsePoint) && !Ignored().IsMatch(sub.FullName + Separator))
                    {
                        queue.Enqueue(sub);
                    }
                }
                else if (entry is FileInfo file && (top || !ReferenceEquals(dir, start)))
                {
                    yield return file;
                }
            }
        }
    }
}
