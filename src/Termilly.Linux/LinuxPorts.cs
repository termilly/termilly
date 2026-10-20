using System.Globalization;
using System.Net;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// The ports a terminal's programs listen on, on Linux, in the same shape as Ports.cs gives on Windows: the TCP
/// sockets in the listening state from /proc/net, each with the process holding it where we may see it (another
/// user's sockets have no owner), and which terminal each process belongs to through its process tree.
/// </summary>
internal static class LinuxPorts
{
    /// <summary>A TCP socket waiting for connections, and the process that owns it (0 when we can't see it).</summary>
    public sealed record Listener(string Address, int Port, int Pid);

    private const string Proc = "/proc";
    /// <summary>TCP_LISTEN in /proc/net/tcp's st column.</summary>
    private const int TcpListen = 0x0A;
    /// <summary>The columns of /proc/net/tcp read: local address, state, inode; and how many a full line has.</summary>
    private const int LocalAddressColumn = 1;
    private const int StateColumn = 3;
    private const int InodeColumn = 9;
    private const int MinColumns = 10;
    private const int IPv4Size = 4;
    private const int IPv6Size = 16;
    /// <summary>An address is written as 32-bit words, each 8 hex digits.</summary>
    private const int WordSize = 4;
    private const int WordDigits = 8;
    private const string SocketLink = "socket:[";
    /// <summary>A process's status line, in its /proc folder.</summary>
    private const string StatFile = "stat";

    /// <summary>Every listening TCP socket (IPv4 and IPv6) from /proc/net, with its process where we can see it.</summary>
    public static IReadOnlyList<Listener> Listening()
    {
        var owners = SocketOwners();
        var list = new List<Listener>();
        foreach (var (file, v6) in new[] { ("tcp", false), ("tcp6", true) })
        {
            foreach (var line in Read($"{Proc}/net/{file}")?.Split('\n').Skip(1) ?? [])
            {
                // sl local_address rem_address st tx_queue:rx_queue tr:tm->when retrnsmt uid timeout inode …
                var f = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (f.Length < MinColumns || int.Parse(f[StateColumn], NumberStyles.HexNumber, CultureInfo.InvariantCulture) != TcpListen)
                {
                    continue;
                }
                var (address, port) = Endpoint(f[LocalAddressColumn], v6);
                list.Add(new Listener(address, port, owners.GetValueOrDefault(f[InodeColumn])));
            }
        }
        return list;
    }

    /// <summary>Every process's parent, from /proc/&lt;pid&gt;/stat (the field after the name in parentheses).</summary>
    internal static Dictionary<int, int> ParentIds()
    {
        var parents = new Dictionary<int, int>();
        foreach (var dir in Directory.EnumerateDirectories(Proc))
        {
            if (!int.TryParse(Path.GetFileName(dir), out var pid))
            {
                continue;
            }
            try
            {
                var stat = File.ReadAllText(Path.Combine(dir, StatFile));
                var fields = stat[(stat.LastIndexOf(')') + 2)..].Split(' ');
                parents[pid] = int.Parse(fields[1], CultureInfo.InvariantCulture);
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is FormatException or IndexOutOfRangeException or ArgumentOutOfRangeException)
            {
                // Gone, or not ours to read.
            }
        }
        return parents;
    }


    /// <summary>"0100007F:0035" (IPv4: one little-endian word) or IPv6's four words, and the port, as an address and number.</summary>
    private static (string Address, int Port) Endpoint(string text, bool v6)
    {
        var parts = text.Split(':');
        var port = int.Parse(parts[1], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
        var hex = parts[0];
        var bytes = new byte[v6 ? IPv6Size : IPv4Size];
        for (var word = 0; word < bytes.Length / WordSize; word++)
        {
            var value = uint.Parse(hex.AsSpan(word * WordDigits, WordDigits), NumberStyles.HexNumber, CultureInfo.InvariantCulture);
            BitConverter.TryWriteBytes(bytes.AsSpan(word * WordSize, WordSize), value); // the kernel wrote them in host (little-endian) order
        }
        var address = new IPAddress(bytes);
        return ((address.IsIPv4MappedToIPv6 ? address.MapToIPv4() : address).ToString(), port);
    }

    /// <summary>Socket inode → the process holding it, from the open files of the processes we may look into.</summary>
    private static Dictionary<string, int> SocketOwners()
    {
        var owners = new Dictionary<string, int>();
        foreach (var dir in Directory.EnumerateDirectories(Proc))
        {
            if (!int.TryParse(Path.GetFileName(dir), out var pid))
            {
                continue;
            }
            try
            {
                foreach (var fd in Directory.EnumerateFileSystemEntries(Path.Combine(dir, "fd")))
                {
                    var target = new FileInfo(fd).LinkTarget;
                    if (target is not null && target.StartsWith(SocketLink, StringComparison.Ordinal))
                    {
                        owners.TryAdd(target[SocketLink.Length..^1], pid);
                    }
                }
            }
            catch (Exception e) when (Storage.IsFileError(e))
            {
                // Another user's process, or one that just ended.
            }
        }
        return owners;
    }

    private static string? Read(string path)
    {
        try
        {
            return File.ReadAllText(path);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null;
        }
    }
}
