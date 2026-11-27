using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Termilly.Desktop;

/// <summary>
/// The command lines of processes: on Windows from the process itself, on Linux from /proc, on macOS from ps. A
/// process that ended, or can't be read, is left out.
/// </summary>
internal static class ProcessCommandLines
{
    /// <summary>How long ps may take before its answer is given up on.</summary>
    private static readonly TimeSpan PsWait = TimeSpan.FromSeconds(5);
    private const string Ps = "/bin/ps";
    /// <summary>ps: each process as its id and its command line, with no header.</summary>
    private static readonly string[] PsColumns = ["-o", "pid=,command="];
    private const string PsProcesses = "-p";

    public static Dictionary<int, string> Of(IReadOnlyCollection<int> pids)
    {
        if (pids.Count == 0)
        {
            return [];
        }
        if (OperatingSystem.IsWindows())
        {
            return Read(pids, Windows);
        }
        return OperatingSystem.IsMacOS() ? Mac(pids) : Read(pids, Linux);
    }

    private static Dictionary<int, string> Read(IEnumerable<int> pids, Func<int, string?> line)
    {
        var lines = new Dictionary<int, string>();
        foreach (var pid in pids)
        {
            if (line(pid) is { Length: > 0 } text)
            {
                lines[pid] = text;
            }
        }
        return lines;
    }

    /// <summary>Linux: its arguments, each ended by a NUL.</summary>
    private static string? Linux(int pid)
    {
        try
        {
            return File.ReadAllText($"/proc/{pid}/cmdline").TrimEnd('\0').Replace('\0', ' ');
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>macOS: one ps for all of them, a "pid command" line each.</summary>
    private static Dictionary<int, string> Mac(IReadOnlyCollection<int> pids)
    {
        var start = new ProcessStartInfo(Ps) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        foreach (var arg in (string[])[.. PsColumns, PsProcesses, string.Join(',', pids)])
        {
            start.ArgumentList.Add(arg);
        }
        try
        {
            using var ps = Process.Start(start)!;
            var output = ps.StandardOutput.ReadToEndAsync();
            if (!ps.WaitForExit(PsWait))
            {
                ps.Kill();
                return [];
            }
            var lines = new Dictionary<int, string>();
            foreach (var parts in output.Result.Split('\n').Select(l => l.Trim().Split(' ', 2)).Where(p => p.Length == 2))
            {
                if (int.TryParse(parts[0], out var pid))
                {
                    lines[pid] = parts[1].Trim();
                }
            }
            return lines;
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return [];
        }
    }

    private const int QueryLimitedInformation = 0x1000;
    /// <summary>NtQueryInformationProcess's ProcessCommandLineInformation (Windows 8.1 and later).</summary>
    private const int CommandLineInformation = 60;
    private const int StatusInfoLengthMismatch = unchecked((int)0xC0000004);
    private const int FirstTry = 4096;

    /// <summary>Windows: asked of the process itself, which only needs the right to query it.</summary>
    [SupportedOSPlatform(OsPlatforms.Windows)]
    private static string? Windows(int pid)
    {
        var handle = OpenProcess(QueryLimitedInformation, false, pid);
        if (handle == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            var size = FirstTry;
            var status = Query(handle, size, out var needed, out var line);
            if (status == StatusInfoLengthMismatch && needed > size)
            {
                status = Query(handle, needed, out _, out line);
            }
            return status == 0 ? line : null;
        }
        finally
        {
            _ = CloseHandle(handle);
        }
    }

    /// <summary>The answer is a UNICODE_STRING (lengths in bytes, then a pointer) with its text after it, in the same block.</summary>
    [SupportedOSPlatform(OsPlatforms.Windows)]
    private static int Query(IntPtr handle, int size, out int needed, out string? line)
    {
        line = null;
        var block = Marshal.AllocHGlobal(size);
        try
        {
            var status = NtQueryInformationProcess(handle, CommandLineInformation, block, size, out needed);
            if (status == 0)
            {
                var bytes = (ushort)Marshal.ReadInt16(block);
                var text = Marshal.ReadIntPtr(block, IntPtr.Size);
                line = text == IntPtr.Zero ? null : Marshal.PtrToStringUni(text, bytes / sizeof(char));
            }
            return status;
        }
        finally
        {
            Marshal.FreeHGlobal(block);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, [MarshalAs(UnmanagedType.Bool)] bool inherit, int pid);

    [DllImport("kernel32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("ntdll.dll")]
    private static extern int NtQueryInformationProcess(IntPtr handle, int infoClass, IntPtr info, int size, out int needed);
}
