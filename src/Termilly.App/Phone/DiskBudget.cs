using System.IO;

namespace Termilly.Desktop.Phone;

/// <summary>
/// Room on this computer's disks for items other computers copy here (PcFilesApi), shared by copies running at once:
/// before writing something (the zip, the unpacked item, the copy in its folder) a copy reserves its size on the disk
/// it lands on, and gives the reservation back as soon as it's written, when the disk's free space shows it instead
/// (held on, it would count twice). A write that doesn't fit beside the others' unwritten ones is refused, and
/// FreeReserve stays free.
/// </summary>
internal sealed class DiskBudget(Func<string, (string Root, long? Free)> diskOf)
{
    /// <summary>Free space left on a disk after copies, at least: they never fill it.</summary>
    public const long FreeReserve = 1L << 30;

    /// <summary>The budget of this computer's disks, shared by every copy.</summary>
    public static DiskBudget Shared { get; } = new(DiskOf);

    private readonly Lock _gate = new();
    /// <summary>Bytes reserved and not yet written, by the disk's root (the mount the path is on).</summary>
    private readonly Dictionary<string, long> _unwritten = new(Comparer);

    private static StringComparer Comparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
    private static StringComparison Comparison => OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;

    /// <summary>
    /// Reserves <paramref name="bytes"/> about to be written on the disk <paramref name="path"/> is on, or null when
    /// they don't fit there beside other copies' unwritten bytes (free space less FreeReserve). A disk whose free space
    /// can't be told takes it. Dispose the reservation once the bytes are written (or not to be); twice is once.
    /// </summary>
    public IDisposable? TryReserve(string path, long bytes)
    {
        lock (_gate)
        {
            // Read under the lock: a reservation given back is on the disk by then, counted by its free space once.
            var (root, free) = diskOf(path);
            var held = _unwritten.GetValueOrDefault(root);
            if (free is { } f && bytes > f - FreeReserve - held)
            {
                return null;
            }
            _unwritten[root] = held + bytes;
            return new Reservation(this, root, bytes);
        }
    }

    /// <summary>The bytes reserved and not yet written on the disk <paramref name="path"/> is on.</summary>
    public long UnwrittenOn(string path)
    {
        lock (_gate)
        {
            return _unwritten.GetValueOrDefault(diskOf(path).Root);
        }
    }

    private void Release(string root, long bytes)
    {
        lock (_gate)
        {
            var left = _unwritten.GetValueOrDefault(root) - bytes;
            if (left > 0)
            {
                _unwritten[root] = left;
            }
            else
            {
                _unwritten.Remove(root);
            }
        }
    }

    private sealed class Reservation(DiskBudget budget, string root, long bytes) : IDisposable
    {
        private int _released;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _released, 1) == 0)
            {
                budget.Release(root, bytes);
            }
        }
    }

    /// <summary>The disk a path is on (its mount's root) and its free space; "" and null when that can't be told.</summary>
    internal static (string Root, long? Free) DiskOf(string path)
    {
        try
        {
            var drives = DriveInfo.GetDrives().Where(d => d.IsReady).ToList();
            var root = MountOf(Path.GetFullPath(path), drives.Select(d => d.RootDirectory.FullName));
            return root is null ? ("", null) : (root, drives.First(d => Comparer.Equals(d.RootDirectory.FullName, root)).AvailableFreeSpace);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return ("", null);
        }
    }

    /// <summary>
    /// The mount <paramref name="path"/> is on: the longest root that is the path itself or a whole-folder prefix of it
    /// (/mnt/data holds /mnt/data/x, not /mnt/database).
    /// </summary>
    internal static string? MountOf(string path, IEnumerable<string> roots) =>
        roots.Where(r => Holds(r, path)).MaxBy(r => r.Length);

    private static bool Holds(string root, string path)
    {
        var trimmed = Path.TrimEndingDirectorySeparator(root);
        if (trimmed.Length == 0 || Path.EndsInDirectorySeparator(trimmed))
        {
            return path.StartsWith(root, Comparison); // the filesystem's own root: / or C:\
        }
        return string.Equals(Path.TrimEndingDirectorySeparator(path), trimmed, Comparison) ||
            path.StartsWith(trimmed + Path.DirectorySeparatorChar, Comparison);
    }
}
