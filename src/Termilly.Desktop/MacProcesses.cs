using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// Every process on macOS, which has no /proc: one sysctl(KERN_PROC_ALL) call returns an array of kinfo_proc
/// structures. The structure is the same size, with its fields at the same offsets, on arm64 and x86_64.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacProcesses
{
    private const int CTL_KERN = 1;
    private const int KERN_PROC = 14;
    private const int KERN_PROC_ALL = 0;
    /// <summary>sysctl's errno when the buffer got too small: processes started between asking the size and reading.</summary>
    private const int ENOMEM = 12;

    /// <summary>sizeof(struct kinfo_proc), and the offsets of kp_proc.p_pid, kp_proc.p_comm and kp_eproc.e_ppid.</summary>
    private const int EntrySize = 648;
    private const int PidOffset = 40;
    private const int CommOffset = 243;
    private const int CommLength = 17;
    private const int ParentOffset = 560;

    /// <summary>Room for processes started between the two calls, so the second one rarely runs short.</summary>
    private const int SlackEntries = 64;
    /// <summary>How many times to try again when the list outgrew the buffer.</summary>
    private const int Attempts = 3;

    /// <summary>Every process: its id, its parent's id and its name (the executable's, at most 16 characters).</summary>
    public static List<ProcessEntry> Snapshot()
    {
        int[] mib = [CTL_KERN, KERN_PROC, KERN_PROC_ALL];
        for (var attempt = 0; ; attempt++)
        {
            nuint size = 0;
            if (sysctl(mib, (uint)mib.Length, null, ref size, IntPtr.Zero, 0) != 0)
            {
                throw new Win32Exception(Marshal.GetLastPInvokeError());
            }
            size += SlackEntries * EntrySize;
            var buffer = new byte[size];
            if (sysctl(mib, (uint)mib.Length, buffer, ref size, IntPtr.Zero, 0) == 0)
            {
                return Parse(buffer.AsSpan(0, (int)size));
            }
            var error = Marshal.GetLastPInvokeError();
            if (error != ENOMEM || attempt + 1 >= Attempts)
            {
                throw new Win32Exception(error);
            }
        }
    }

    /// <summary>The processes in sysctl's array of kinfo_proc.</summary>
    internal static List<ProcessEntry> Parse(ReadOnlySpan<byte> entries)
    {
        var list = new List<ProcessEntry>(entries.Length / EntrySize);
        for (var at = 0; at + EntrySize <= entries.Length; at += EntrySize)
        {
            var entry = entries.Slice(at, EntrySize);
            var comm = entry.Slice(CommOffset, CommLength);
            var end = comm.IndexOf((byte)0);
            list.Add(new ProcessEntry(
                BinaryPrimitives.ReadInt32LittleEndian(entry[PidOffset..]),
                BinaryPrimitives.ReadInt32LittleEndian(entry[ParentOffset..]),
                Encoding.UTF8.GetString(end < 0 ? comm : comm[..end])));
        }
        return list;
    }

    [DllImport("libc", SetLastError = true)]
    private static extern int sysctl(int[] name, uint length, byte[]? oldValue, ref nuint oldLength, IntPtr newValue, nuint newLength);
}
