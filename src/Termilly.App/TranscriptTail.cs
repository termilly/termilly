using System.Buffers;
using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Follows a file of JSON lines as it grows (a Claude Code transcript): each <see cref="Read"/> takes only what was
/// written since the last and hands over its whole lines. A line longer than the limit (a tool's output, a file) is
/// skipped unread.
/// </summary>
internal sealed class TranscriptTail(string path, int maxLine)
{
    private const int Chunk = 1 << 20;

    /// <summary>One whole line; true when it changed what the reader keeps.</summary>
    public delegate bool LineReader(ReadOnlySpan<byte> line);

    private readonly ArrayBufferWriter<byte> _pending = new();
    private long _offset;
    private bool _skipping;

    public string Path { get; } = path;

    /// <summary>Reads what was added since the last call; true when one of its lines changed something.</summary>
    public bool Read(LineReader line)
    {
        FileStream file;
        try
        {
            file = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return false;
        }
        using (file)
        {
            if (file.Length <= _offset)
            {
                return false; // nothing new, or rewritten under us (keep what we have)
            }
            file.Seek(_offset, SeekOrigin.Begin);
            var changed = false;
            var buffer = new byte[Chunk];
            int read;
            while ((read = file.Read(buffer, 0, buffer.Length)) > 0)
            {
                changed |= Feed(buffer.AsSpan(0, read), line);
                _offset += read;
            }
            return changed;
        }
    }

    /// <summary>Splits what was read into lines (a line can span reads).</summary>
    private bool Feed(ReadOnlySpan<byte> span, LineReader line)
    {
        var changed = false;
        while (span.Length > 0)
        {
            var end = span.IndexOf((byte)'\n');
            var part = end < 0 ? span : span[..end];
            if (!_skipping)
            {
                if (_pending.WrittenCount + part.Length > maxLine)
                {
                    _skipping = true;
                    _pending.ResetWrittenCount();
                }
                else
                {
                    _pending.Write(part);
                }
            }
            if (end < 0)
            {
                break;
            }
            if (!_skipping)
            {
                changed |= line(_pending.WrittenSpan);
            }
            _pending.ResetWrittenCount();
            _skipping = false;
            span = span[(end + 1)..];
        }
        return changed;
    }
}
