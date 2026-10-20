using System.Net;
using System.Runtime.InteropServices;

namespace Termilly.Desktop;

/// <summary>
/// The ports a terminal's programs listen on, for its sidebar row (js/gitstatus.js): the TCP sockets in the listening
/// state with the process that owns each, and which terminal each process belongs to through its process tree. Read
/// from Windows itself: no WMI, no extra packages.
/// </summary>
internal static class Ports
{
    /// <summary>Address families: IPv4 and IPv6.</summary>
    private const int AF_INET = 2, AF_INET6 = 23;
    private const int MIB_TCP_STATE_LISTEN = 2;
    private const int TCP_TABLE_OWNER_PID_ALL = 5;
    private const uint TH32CS_SNAPPROCESS = 0x2;
    /// <summary>Room for rows added between asking the table's size and reading it.</summary>
    private const int TableSlack = 4096;
    /// <summary>A table starts with its row count.</summary>
    private const int CountSize = sizeof(int);
    private const int IPv4Size = 4;
    private const int IPv6Size = 16;

    /// <summary>MIB_TCPROW_OWNER_PID's layout: state, local address, port, ..., owning process.</summary>
    private static class Row4
    {
        public const int State = 0, Address = 4, Port = 8, Pid = 20, Size = 24;
    }

    /// <summary>MIB_TCP6ROW_OWNER_PID's layout: local address first, then its scope, port, ..., state, owning process.</summary>
    private static class Row6
    {
        public const int Address = 0, Port = 20, State = 48, Pid = 52, Size = 56;
    }

    /// <summary>A port's two bytes, swapped from network order.</summary>
    private const int ByteBits = 8;
    private const int ByteMask = 0xFF;
    /// <summary>A TCP socket waiting for connections, and the process that owns it.</summary>
    public sealed record Listener(string Address, int Port, int Pid);

    /// <summary>Every listening TCP socket (IPv4 and IPv6) with its process.</summary>
    public static IReadOnlyList<Listener> Listening()
    {
        var list = new List<Listener>();
        foreach (var (family, v6) in new[] { (AF_INET, false), (AF_INET6, true) })
        {
            ReadTcpTable(family, (buffer, offset) =>
            {
                // MIB_TCPROW_OWNER_PID (24 bytes) or MIB_TCP6ROW_OWNER_PID (56 bytes).
                var state = Marshal.ReadInt32(buffer, offset + (v6 ? Row6.State : Row4.State));
                if (state == MIB_TCP_STATE_LISTEN)
                {
                    var address = Address(buffer, offset + (v6 ? Row6.Address : Row4.Address), v6);
                    var port = Port(buffer, offset + (v6 ? Row6.Port : Row4.Port));
                    var pid = Marshal.ReadInt32(buffer, offset + (v6 ? Row6.Pid : Row4.Pid));
                    list.Add(new Listener(address, port, pid));
                }
                return v6 ? Row6.Size : Row4.Size;
            });
        }
        return list;
    }


    /// <summary>Every process's parent, from one Toolhelp snapshot (cheap, and needs no access to the processes).</summary>
    internal static Dictionary<int, int> ParentIds()
    {
        var parents = new Dictionary<int, int>();
        var snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1))
        {
            return parents;
        }
        try
        {
            var entry = new ProcessEntry { Size = (uint)Marshal.SizeOf<ProcessEntry>() };
            for (var more = Process32First(snapshot, ref entry); more; more = Process32Next(snapshot, ref entry))
            {
                parents[(int)entry.ProcessId] = (int)entry.ParentProcessId;
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        return parents;
    }

    private delegate int RowReader(IntPtr buffer, int offset);

    /// <summary>Reads an "owner PID" TCP table: a count, then fixed-size rows.</summary>
    private static void ReadTcpTable(int family, RowReader read)
    {
        var size = 0;
        _ = GetExtendedTcpTable(IntPtr.Zero, ref size, false, family, TCP_TABLE_OWNER_PID_ALL, 0);
        if (size == 0)
        {
            return;
        }
        size += TableSlack; // the table can grow between the two calls
        var buffer = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buffer, ref size, false, family, TCP_TABLE_OWNER_PID_ALL, 0) != 0)
            {
                return;
            }
            var count = Marshal.ReadInt32(buffer);
            var offset = CountSize;
            for (var i = 0; i < count && offset < size; i++)
            {
                offset += read(buffer, offset);
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    private static string Address(IntPtr buffer, int offset, bool v6)
    {
        var bytes = new byte[v6 ? IPv6Size : IPv4Size];
        Marshal.Copy(buffer + offset, bytes, 0, bytes.Length);
        var address = new IPAddress(bytes);
        return address.IsIPv4MappedToIPv6 ? address.MapToIPv4().ToString() : address.ToString();
    }

    /// <summary>A port as these tables keep it: in network byte order, in the low 16 bits.</summary>
    private static int Port(IntPtr buffer, int offset)
    {
        var raw = Marshal.ReadInt32(buffer, offset);
        return ((raw & ByteMask) << ByteBits) | ((raw >> ByteBits) & ByteMask);
    }

    // ---- Windows ----

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessEntry
    {
        public uint Size, Usage, ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId, Threads, ParentProcessId;
        public int PriorityClassBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string ExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", EntryPoint = "Process32FirstW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", EntryPoint = "Process32NextW", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("iphlpapi.dll")]
    private static extern uint GetExtendedTcpTable(IntPtr table, ref int size, [MarshalAs(UnmanagedType.Bool)] bool order, int family, int tableClass, uint reserved);
}
