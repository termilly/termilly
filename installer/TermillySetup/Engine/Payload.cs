using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace Termilly.Setup.Engine;

/// <summary>
/// What setup installs, appended to TermillySetup.exe by installer/build.ps1: a zip, then a 48-byte footer
/// (the zip's offset as Int64, its SHA-256, and the magic "TMLYPAY1"). The zip holds:
/// <list type="bullet">
/// <item><c>app/…</c>: Termilly's files, as they go into the install folder</item>
/// <item><c>prereqs/windowsdesktop-runtime-win-x64.exe</c>: the .NET 10 Desktop Runtime installer</item>
/// <item><c>prereqs/MicrosoftEdgeWebView2RuntimeInstallerX64.exe</c>: the WebView2 standalone installer</item>
/// <item><c>version.txt</c>: Termilly's version</item>
/// </list>
/// Setup copied into the install folder keeps only the program part (<see cref="ProgramLength"/>), so it can
/// uninstall without carrying the payload.
/// </summary>
internal sealed class Payload
{
    public const string Magic = "TMLYPAY1";

    /// <summary>The version of a payload that doesn't say which it is.</summary>
    private const string UnknownVersion = "0.0.0";

    /// <summary>The footer's parts: the zip's offset (an Int64), its SHA-256, and the magic.</summary>
    private const int OffsetLength = sizeof(long);
    private const int HashLength = 32;
    private const int MagicLength = 8;
    public const int FooterLength = OffsetLength + HashLength + MagicLength;
    /// <summary>A signature added to the exe is padded to this many bytes, so the footer can end up to this far before it.</summary>
    private const int SignaturePadding = 8;

    /// <summary>The PE format: where the PE header's offset is, its signature ("PE\0\0"), and the optional header past
    /// it (after the 4-byte signature and the 20-byte file header).</summary>
    private const int PeOffsetAt = 0x3C;
    private const uint PeSignature = 0x00004550;
    private const int OptionalHeaderAt = 24;
    /// <summary>The optional header's magic for PE32+ (64-bit), and where its data directory 4 (security) is: PE32+ at
    /// +144, PE32 at +128.</summary>
    private const ushort Pe32PlusMagic = 0x20B;
    private const int SecurityDirectoryPe32Plus = 144;
    private const int SecurityDirectoryPe32 = 128;
    /// <summary>Room a PE header needs at least, from where it starts to the file's end.</summary>
    private const int MinimumHeaderRoom = 256;
    public const string DotNetEntry = "prereqs/windowsdesktop-runtime-win-x64.exe";
    public const string WebView2Entry = "prereqs/MicrosoftEdgeWebView2RuntimeInstallerX64.exe";

    private readonly string _file;
    private readonly byte[] _hash;

    private Payload(string file, long offset, long length, byte[] hash, string version)
    {
        _file = file;
        ProgramLength = offset;
        Length = length;
        _hash = hash;
        Version = version;
    }

    /// <summary>The size of setup's own program, before the payload.</summary>
    public long ProgramLength { get; }

    public long Length { get; }

    /// <summary>Termilly's version in the payload, e.g. "1.0.0".</summary>
    public string Version { get; }

    /// <summary>The payload appended to <paramref name="file"/>, or null when there is none (an installed setup).</summary>
    public static Payload? Open(string file)
    {
        try
        {
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            // Signing appends the signature after everything (padded to 8 bytes): the footer ends where it starts.
            var end = SignatureStart(stream) ?? stream.Length;
            if (end < FooterLength + SignaturePadding)
            {
                return null;
            }
            var tail = new byte[FooterLength + SignaturePadding];
            stream.Seek(end - tail.Length, SeekOrigin.Begin);
            ReadExactly(stream, tail);
            var magicAt = LastIndexOf(tail, Encoding.ASCII.GetBytes(Magic));
            if (magicAt < FooterLength - MagicLength)
            {
                return null;
            }
            var footer = tail.Skip(magicAt + MagicLength - FooterLength).Take(FooterLength).ToArray();
            var footerStart = end - tail.Length + magicAt + MagicLength - FooterLength;
            var offset = BitConverter.ToInt64(footer, 0);
            var length = footerStart - offset;
            if (offset <= 0 || length <= 0)
            {
                return null;
            }
            var hash = footer.Skip(OffsetLength).Take(HashLength).ToArray();
            string version;
            using (var zip = new ZipArchive(new SubStream(stream, offset, length), ZipArchiveMode.Read, leaveOpen: true))
            {
                var entry = zip.GetEntry("version.txt");
                using var reader = new StreamReader(entry?.Open() ?? new MemoryStream());
                version = reader.ReadToEnd().Trim();
            }
            return new Payload(file, offset, length, hash, version.Length > 0 ? version : UnknownVersion);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or InvalidDataException)
        {
            Log.Write($"No payload in {file}: {e.Message}");
            return null;
        }
    }

    /// <summary>Whether the payload is what build.ps1 wrote (a damaged or cut-short download isn't).</summary>
    public bool Verify()
    {
        using var stream = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(new SubStream(stream, ProgramLength, Length));
        return hash.SequenceEqual(_hash);
    }

    /// <summary>Opens the payload's zip; dispose it when done.</summary>
    public ZipArchive OpenZip()
    {
        var stream = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.Read);
        return new ZipArchive(new SubStream(stream, ProgramLength, Length, ownsInner: true), ZipArchiveMode.Read);
    }

    public bool Has(string entry)
    {
        using var zip = OpenZip();
        return zip.GetEntry(entry) is not null;
    }

    /// <summary>Copies one entry out to <paramref name="path"/>.</summary>
    public void Extract(string entry, string path)
    {
        using var zip = OpenZip();
        var item = zip.GetEntry(entry) ?? throw new SetupException($"Setup is missing {entry}.");
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        using var from = item.Open();
        using var to = File.Create(path);
        from.CopyTo(to);
    }

    /// <summary>Writes setup's program part alone (no payload) to <paramref name="path"/>: the installed uninstaller.</summary>
    public void WriteProgram(string path)
    {
        using var from = new FileStream(_file, FileMode.Open, FileAccess.Read, FileShare.Read);
        using var to = File.Create(path);
        CopyBytes(from, to, ProgramLength);
    }

    /// <summary>The bytes setup's own exe holds before any payload (the whole file when there is none).</summary>
    public static void WriteProgramOf(string setupFile, string path)
    {
        if (Open(setupFile) is { } payload)
        {
            payload.WriteProgram(path);
        }
        else
        {
            File.Copy(setupFile, path, overwrite: true);
        }
    }

    /// <summary>Where the Authenticode signature starts (the PE certificate table, at the file's end), or null if unsigned.</summary>
    private static long? SignatureStart(Stream stream)
    {
        var reader = new BinaryReader(stream);
        stream.Seek(PeOffsetAt, SeekOrigin.Begin);
        var pe = reader.ReadInt32();
        if (pe <= 0 || pe > stream.Length - MinimumHeaderRoom)
        {
            return null;
        }
        stream.Seek(pe, SeekOrigin.Begin);
        if (reader.ReadUInt32() != PeSignature)
        {
            return null;
        }
        var optional = pe + OptionalHeaderAt;
        stream.Seek(optional, SeekOrigin.Begin);
        var magic = reader.ReadUInt16();
        stream.Seek(optional + (magic == Pe32PlusMagic ? SecurityDirectoryPe32Plus : SecurityDirectoryPe32), SeekOrigin.Begin);
        var at = reader.ReadUInt32();
        var size = reader.ReadUInt32();
        return at > 0 && size > 0 && at + (long)size == stream.Length ? at : null;
    }

    private static int LastIndexOf(byte[] data, byte[] pattern)
    {
        for (var i = data.Length - pattern.Length; i >= 0; i--)
        {
            var j = 0;
            while (j < pattern.Length && data[i + j] == pattern[j])
            {
                j++;
            }
            if (j == pattern.Length)
            {
                return i;
            }
        }
        return -1;
    }

    private static void CopyBytes(Stream from, Stream to, long count)
    {
        var buffer = new byte[Bytes.CopyBuffer];
        while (count > 0)
        {
            var read = from.Read(buffer, 0, (int)Math.Min(buffer.Length, count));
            if (read == 0)
            {
                throw new EndOfStreamException();
            }
            to.Write(buffer, 0, read);
            count -= read;
        }
    }

    private static void ReadExactly(Stream stream, byte[] buffer)
    {
        var done = 0;
        while (done < buffer.Length)
        {
            var read = stream.Read(buffer, done, buffer.Length - done);
            if (read == 0)
            {
                throw new EndOfStreamException();
            }
            done += read;
        }
    }
}

/// <summary>A read-only window onto part of another stream (the payload inside setup's exe).</summary>
internal sealed class SubStream : Stream
{
    private readonly Stream _inner;
    private readonly long _start;
    private readonly long _length;
    private readonly bool _ownsInner;
    private long _position;

    public SubStream(Stream inner, long start, long length, bool ownsInner = false)
    {
        _inner = inner;
        _start = start;
        _length = length;
        _ownsInner = ownsInner;
    }

    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => _length;

    public override long Position
    {
        get => _position;
        set => _position = Math.Max(0, Math.Min(value, _length));
    }

    public override int Read(byte[] buffer, int offset, int count)
    {
        var left = _length - _position;
        if (left <= 0)
        {
            return 0;
        }
        _inner.Seek(_start + _position, SeekOrigin.Begin);
        var read = _inner.Read(buffer, offset, (int)Math.Min(count, left));
        _position += read;
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => offset,
            SeekOrigin.Current => _position + offset,
            _ => _length + offset,
        };
        return _position;
    }

    public override void Flush()
    {
    }

    public override void SetLength(long value) => throw new NotSupportedException();

    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

    protected override void Dispose(bool disposing)
    {
        if (disposing && _ownsInner)
        {
            _inner.Dispose();
        }
        base.Dispose(disposing);
    }
}

/// <summary>A failure setup explains to the user as it is (the message is shown on the error page).</summary>
internal sealed class SetupException : Exception
{
    public SetupException(string message, string? detail = null)
        : base(message)
    {
        Detail = detail;
    }

    /// <summary>A second line: what the user can do about it.</summary>
    public string? Detail { get; }
}
