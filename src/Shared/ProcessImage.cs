using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
#if !NETFRAMEWORK
using System.Runtime.Versioning;
#endif

namespace Termilly.Shared;

/// <summary>Where a running program's exe is, read with the least access Windows allows (it works across elevation).</summary>
#if !NETFRAMEWORK
[SupportedOSPlatform(OsPlatforms.Windows)]
#endif
internal static class ProcessImage
{
    /// <summary>PROCESS_QUERY_LIMITED_INFORMATION: enough to read a process's path.</summary>
    private const int QueryLimitedInformation = 0x1000;
    /// <summary>Room for a process's path, long paths included.</summary>
    private const int MaxPath = 1024;

    /// <summary>The exe's full path, or null when the process is gone or can't be asked.</summary>
    public static string? PathOf(int processId)
    {
        var handle = OpenProcess(QueryLimitedInformation, false, processId);
        if (handle == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            var buffer = new char[MaxPath];
            var size = buffer.Length;
            return QueryFullProcessImageName(handle, 0, buffer, ref size) ? new string(buffer, 0, size) : null;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>The exe paths of the processes running from <paramref name="dir"/>, other than <paramref name="except"/>.</summary>
    public static List<string> InFolder(string dir, int except)
    {
        var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        var found = new List<string>();
        foreach (var process in Process.GetProcesses())
        {
            using (process)
            {
                if (process.Id != except && PathOf(process.Id) is { } path && path.StartsWith(root, StringComparison.OrdinalIgnoreCase))
                {
                    found.Add(path);
                }
            }
        }
        return found;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, [Out] char[] name, ref int size);

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
