using System.IO;
using System.IO.Compression;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Unpacks an item another computer copied here (PcFilesApi) within limits: a zip that says it unpacks to more than
/// the room reserved for it (DiskBudget), or holds more than MaxEntries files, is refused before anything is written, and a file whose
/// data runs past the size its entry states stops there (a zip can lie about sizes). Otherwise as
/// ZipFile.ExtractToDirectory: nothing lands outside the folder, and files keep their times and Unix permissions.
/// </summary>
internal static class ItemUnzip
{
    /// <summary>The most files and folders an item may hold (a project folder with its packages fits).</summary>
    public const int MaxEntries = 1_000_000;

    /// <summary>Where a Unix entry keeps its permission bits, and which of them are kept.</summary>
    private const int UnixModeShift = 16;
    private const int UnixPermissions = 0b111_111_111;

    private const int Chunk = 81920;

    /// <summary>
    /// What <paramref name="zip"/> says it unpacks to, in bytes (what's reserved for it, see DiskBudget); a zip with
    /// more than MaxEntries files is refused.
    /// </summary>
    public static long Size(string zip)
    {
        using var archive = ZipFile.OpenRead(zip);
        return SizeOf(archive);
    }

    private static long SizeOf(ZipArchive archive) => archive.Entries.Count > MaxEntries
        ? throw new InvalidDataException($"The copy holds more than {MaxEntries:N0} files.")
        : archive.Entries.Sum(e => e.Length);

    /// <summary>Unpacks <paramref name="zip"/> into <paramref name="folder"/>, at most <paramref name="maxBytes"/> in all.</summary>
    public static void Extract(string zip, string folder, long maxBytes)
    {
        var root = Path.GetFullPath(folder);
        var inside = Path.EndsInDirectorySeparator(root) ? root : root + Path.DirectorySeparatorChar;
        using var archive = ZipFile.OpenRead(zip);
        if (SizeOf(archive) > maxBytes)
        {
            throw new InvalidDataException("Unpacked, the copy needs more room than this computer has free.");
        }
        Directory.CreateDirectory(root);
        foreach (var entry in archive.Entries)
        {
            var path = Path.GetFullPath(Path.Combine(root, entry.FullName));
            if (!path.StartsWith(inside, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            {
                throw new IOException("The copy has a file that would land outside its folder.");
            }
            // A folder's entry has no name of its own (its full name ends in a slash).
            if (entry.Name.Length == 0)
            {
                Directory.CreateDirectory(path);
                continue;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            using (var input = entry.Open())
            using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write))
            {
                CopyAtMost(input, output, entry.Length);
            }
            Storage.Try(() => File.SetLastWriteTime(path, entry.LastWriteTime.DateTime));
            var mode = (entry.ExternalAttributes >> UnixModeShift) & UnixPermissions;
            if (!OperatingSystem.IsWindows() && mode != 0)
            {
                File.SetUnixFileMode(path, (UnixFileMode)mode);
            }
        }
    }

    /// <summary>Copies a file's data, which must not be more than its entry says.</summary>
    private static void CopyAtMost(Stream input, Stream output, long limit)
    {
        var buffer = new byte[Chunk];
        long written = 0;
        int read;
        while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
        {
            written += read;
            if (written > limit)
            {
                throw new InvalidDataException("A file in the copy is larger than the copy says.");
            }
            output.Write(buffer, 0, read);
        }
    }
}
