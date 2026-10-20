using System.Buffers.Binary;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Principal;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Termilly.Pty;

/// <summary>
/// How Termilly's window and its background host (termilly-host, which owns the pseudo terminals so shells keep
/// running when the window closes) talk: frames of a 4-byte little-endian length and a UTF-8 JSON object, over a
/// named pipe (a Unix socket on Linux) only the same user can open.
/// </summary>
/// <remarks>
/// Window → host: hello { v }, start { id, cmd, cols, rows, cwd, env }, attach { id }, input { id, d },
/// resize { id, cols, rows }, kill { id }, shutdown.
/// Host → window: hello { v, sessions: [{ id, pid, alive, exit }] }, started { id, pid }, failed { id, message },
/// out { id, d }, replay { id, d }, exit { id, code }.
/// </remarks>
public static class HostProtocol
{
    /// <summary>Bump when a message changes shape; a window and host of different versions don't mix.</summary>
    public const int Version = 1;

    private const int MaxFrame = 8 * 1024 * 1024;

    /// <summary>A frame starts with its length: 4 bytes, little-endian.</summary>
    private const int HeaderSize = sizeof(int);

    /// <summary>
    /// One host per user: the user's SID (Windows) or uid (Linux) keeps two users on one PC apart.
    /// TERMILLY_HOST_PIPE names another, so a test run doesn't meet the user's own host.
    /// </summary>
    public static string PipeName { get; } = Environment.GetEnvironmentVariable("TERMILLY_HOST_PIPE") is { Length: > 0 } test ? test : $"termilly-host-{(OperatingSystem.IsWindows() ? WindowsIdentity.GetCurrent().User?.Value ?? Environment.UserName : geteuid().ToString(System.Globalization.CultureInfo.InvariantCulture))}";

    [DllImport("libc")]
    private static extern uint geteuid();

    public static void Write(Stream stream, HostRequest message) => WriteFrame(stream, JsonSerializer.SerializeToUtf8Bytes(message, HostJson.Options));

    public static void Write(Stream stream, HostEvent message) => WriteFrame(stream, JsonSerializer.SerializeToUtf8Bytes(message, HostJson.Options));

    /// <summary>The window's next request, or null when it has gone.</summary>
    public static HostRequest? ReadRequest(Stream stream) => Read<HostRequest>(stream);

    /// <summary>The host's next event, or null when it has gone.</summary>
    public static HostEvent? ReadEvent(Stream stream) => Read<HostEvent>(stream);

    private static void WriteFrame(Stream stream, byte[] body)
    {
        var frame = new byte[HeaderSize + body.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, body.Length);
        body.CopyTo(frame, HeaderSize);
        stream.Write(frame);
        stream.Flush();
    }

    /// <summary>The next message; one of a kind this side doesn't know is skipped. Null when the other side has gone.</summary>
    private static T? Read<T>(Stream stream)
        where T : class
    {
        while (ReadFrame(stream) is { } body)
        {
            using var message = JsonDocument.Parse(body);
            if (message.RootElement.TryGetProperty(Kinds<T>.Property, out var kind) && kind.GetString() is { } name && Kinds<T>.Known.Contains(name))
            {
                return message.RootElement.Deserialize<T>(HostJson.Options);
            }
        }
        return null;
    }

    /// <summary>The property that names a message's kind ("op", "ev"), and the kinds this version has.</summary>
    private static class Kinds<T>
    {
        public static readonly string Property = typeof(T).GetCustomAttribute<JsonPolymorphicAttribute>()!.TypeDiscriminatorPropertyName!;

        public static readonly HashSet<string> Known =
            [.. typeof(T).GetCustomAttributes<JsonDerivedTypeAttribute>().Select(t => (string)t.TypeDiscriminator!)];
    }

    private static byte[]? ReadFrame(Stream stream)
    {
        var header = new byte[HeaderSize];
        if (!ReadExactly(stream, header))
        {
            return null;
        }
        var length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length is < 0 or > MaxFrame)
        {
            return null;
        }
        var body = new byte[length];
        return ReadExactly(stream, body) ? body : null;
    }

    private static bool ReadExactly(Stream stream, byte[] buffer)
    {
        var read = 0;
        while (read < buffer.Length)
        {
            var n = stream.Read(buffer, read, buffer.Length - read);
            if (n == 0)
            {
                return false;
            }
            read += n;
        }
        return true;
    }
}

/// <summary>
/// The last part of a terminal's output, kept by the host so a window that attaches later can show it again.
/// Bounded in characters; the oldest output goes first.
/// </summary>
public sealed class OutputRing(int capacity = OutputRing.DefaultCapacity)
{
    /// <summary>How much output a ring keeps by default, in characters.</summary>
    public const int DefaultCapacity = 512 * 1024;

    private readonly LinkedList<string> _chunks = new();
    private int _length;

    public void Add(string text)
    {
        lock (_chunks)
        {
            _chunks.AddLast(text);
            _length += text.Length;
            while (_length > capacity && _chunks.Count > 1)
            {
                _length -= _chunks.First!.Value.Length;
                _chunks.RemoveFirst();
            }
        }
    }

    public string Text()
    {
        lock (_chunks)
        {
            return string.Concat(_chunks);
        }
    }
}
