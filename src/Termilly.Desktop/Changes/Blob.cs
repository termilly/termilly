using System.IO;
using System.Text;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// A file's contents at one moment, as the change preview keeps it: the bytes of a text file, or only the size of a
/// binary file or one over the size limit. A missing file has <see cref="Exists"/> false.
/// </summary>
internal sealed record Blob(bool Exists, byte[]? Bytes, bool Binary, bool TooLarge, long Size)
{
    public static readonly Blob Missing = new(false, null, false, false, 0);

    /// <summary>How much of a file is looked at to tell text from binary.</summary>
    private const int SniffBytes = 8000;

    private static readonly byte[] Utf8Mark = [0xEF, 0xBB, 0xBF];
    private static readonly byte[] Utf16LittleEndianMark = [0xFF, 0xFE];
    private static readonly byte[] Utf16BigEndianMark = [0xFE, 0xFF];

    public bool IsText => Exists && Bytes is not null;

    /// <summary>Reads a file without getting in the way of whoever is writing it.</summary>
    public static Blob Read(string path, long maxBytes)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                return Missing;
            }
            if (info.Length > maxBytes)
            {
                return new Blob(true, null, false, true, info.Length);
            }
            using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var copy = new MemoryStream((int)Math.Min(info.Length, maxBytes));
            stream.CopyTo(copy);
            return From(copy.ToArray(), maxBytes);
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or NotSupportedException)
        {
            return Missing;
        }
    }

    public static Blob From(byte[] bytes, long maxBytes)
    {
        if (bytes.Length > maxBytes)
        {
            return new Blob(true, null, false, true, bytes.Length);
        }
        var head = bytes.AsSpan(0, Math.Min(bytes.Length, SniffBytes));
        // UTF-16 text has NULs too; its byte order mark says it is text.
        var utf16 = head.StartsWith(Utf16LittleEndianMark) || head.StartsWith(Utf16BigEndianMark);
        return !utf16 && head.Contains((byte)0)
            ? new Blob(true, null, true, false, bytes.Length)
            : new Blob(true, bytes, false, false, bytes.Length);
    }

    public static Blob FromText(string text, long maxBytes) => From(Encoding.UTF8.GetBytes(text), maxBytes);

    /// <summary>The text, decoded by its byte order mark or else as UTF-8.</summary>
    public string? Text()
    {
        if (Bytes is not { } b)
        {
            return null;
        }
        if (b.AsSpan().StartsWith(Utf8Mark))
        {
            return Encoding.UTF8.GetString(b, Utf8Mark.Length, b.Length - Utf8Mark.Length);
        }
        if (b.AsSpan().StartsWith(Utf16LittleEndianMark))
        {
            return Encoding.Unicode.GetString(b, Utf16LittleEndianMark.Length, b.Length - Utf16LittleEndianMark.Length);
        }
        if (b.AsSpan().StartsWith(Utf16BigEndianMark))
        {
            return Encoding.BigEndianUnicode.GetString(b, Utf16BigEndianMark.Length, b.Length - Utf16BigEndianMark.Length);
        }
        return Encoding.UTF8.GetString(b);
    }

    public bool SameAs(Blob other) =>
        Exists == other.Exists && Size == other.Size &&
        (Bytes is null || other.Bytes is null ? Bytes is null && other.Bytes is null : Bytes.AsSpan().SequenceEqual(other.Bytes));
}
