using System.Globalization;
using System.IO;

namespace Termilly.Desktop;

/// <summary>A folder as the Files panel lists it: its full path and what's in it.</summary>
internal sealed record FolderListing(string Path, List<FolderEntry> Entries);

/// <summary>A file or folder in a listing; Permissions is the server's ls text (empty on this machine), Label a drive's name.</summary>
internal sealed record FolderEntry(string Name, bool IsDirectory, long Size, string Modified, string Permissions, string? Label = null);

/// <summary>
/// The Files panel's folders on this machine, for a terminal that isn't SSH: listing one, and renaming, making
/// folders and copying files in, as a file manager would. Deleting goes to the Recycle Bin (IDesktopShell.Trash).
/// </summary>
internal static class LocalFiles
{
    private const string ModifiedFormat = "yyyy-MM-dd HH:mm";
    private const long Gigabyte = 1L << 30;

    /// <summary>A folder's entries, folders first, then files, by name ("~" or empty: the home folder; FolderPaths.Drives: the drives).</summary>
    public static FolderListing List(string? folder)
    {
        if (folder == Messaging.FolderPaths.Drives)
        {
            return new(folder, Drives());
        }
        var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
        var path = string.IsNullOrEmpty(folder) || folder == "~" ? home
            : folder.StartsWith("~/", StringComparison.Ordinal) ? Path.Combine(home, folder[2..])
            : folder;
        var dir = new DirectoryInfo(Path.GetFullPath(path));
        if (!dir.Exists)
        {
            throw new IOException($"{dir.FullName} isn't there.");
        }
        // Hidden files show, as they do over SFTP (.env, .gitignore); Windows' system files (desktop.ini) don't.
        var options = new EnumerationOptions { IgnoreInaccessible = true, AttributesToSkip = FileAttributes.System };
        try
        {
            var entries = dir.EnumerateFileSystemInfos("*", options)
                .Select(e => new FolderEntry(e.Name, e is DirectoryInfo, e is FileInfo f ? f.Length : 0,
                    e.LastWriteTime.ToString(ModifiedFormat, CultureInfo.InvariantCulture), ""))
                .OrderBy(e => !e.IsDirectory).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase)
                .ToList();
            return new(dir.FullName, entries);
        }
        catch (UnauthorizedAccessException)
        {
            throw new IOException($"{dir.FullName} can't be read.");
        }
    }

    /// <summary>
    /// The drives that are there (a card reader without a card isn't), as folders named by their root ("C:\"), with
    /// their label and free space: "Local Disk", "Network" for a mapped share without one.
    /// </summary>
    private static List<FolderEntry> Drives() =>
        DriveInfo.GetDrives().Where(d => d.IsReady).Select(d =>
        {
            var label = d.VolumeLabel is { Length: > 0 } name ? name : d.DriveType == DriveType.Network ? "Network" : "Local Disk";
            var free = $"{d.AvailableFreeSpace / Gigabyte:N0} GB free of {d.TotalSize / Gigabyte:N0} GB";
            return new FolderEntry(d.Name, true, 0, free, d.DriveType.ToString(), label);
        }).ToList();

    /// <summary>Renames (or moves) a file or folder; an existing one at <paramref name="to"/> is never replaced.</summary>
    public static void Rename(string path, string to)
    {
        if (File.Exists(to) || Directory.Exists(to))
        {
            throw new IOException($"{Path.GetFileName(to)} is already there.");
        }
        Guarded(() =>
        {
            if (Directory.Exists(path))
            {
                Directory.Move(path, to);
            }
            else
            {
                File.Move(path, to);
            }
        });
    }

    public static void MakeDirectory(string path)
    {
        if (File.Exists(path) || Directory.Exists(path))
        {
            throw new IOException($"{Path.GetFileName(path)} is already there.");
        }
        Guarded(() => Directory.CreateDirectory(path));
    }

    /// <summary>Copies a file into a folder, as "name (1).ext" when the name is taken; the copy's path.</summary>
    public static string CopyInto(string file, string folder)
    {
        if (!File.Exists(file))
        {
            throw new IOException("Only files can be copied, not folders.");
        }
        var target = FreeName(Path.Combine(folder, Path.GetFileName(file)));
        Guarded(() => File.Copy(file, target));
        return target;
    }

    /// <summary>"name.txt", or "name (1).txt" when that's taken.</summary>
    public static string FreeName(string path)
    {
        var dir = Path.GetDirectoryName(path)!;
        var stem = Path.GetFileNameWithoutExtension(path);
        var ext = Path.GetExtension(path);
        for (var i = 1; File.Exists(path) || Directory.Exists(path); i++)
        {
            path = Path.Combine(dir, $"{stem} ({i}){ext}");
        }
        return path;
    }

    /// <summary>Runs a change, with a missing permission told as an IOException like the rest.</summary>
    private static void Guarded(Action change)
    {
        try
        {
            change();
        }
        catch (UnauthorizedAccessException e)
        {
            throw new IOException(e.Message, e);
        }
    }
}
