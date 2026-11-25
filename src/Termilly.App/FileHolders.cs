using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Runtime.Versioning;

namespace Termilly.Desktop;

/// <summary>
/// The processes that have a file open: on Windows from the Restart Manager, on Linux from /proc, on macOS from lsof.
/// Empty when it can't be told.
/// </summary>
internal static partial class FileHolders
{
    /// <summary>How long lsof may take before its answer is given up on.</summary>
    private static readonly TimeSpan LsofWait = TimeSpan.FromSeconds(5);
    private const string Lsof = "/usr/sbin/lsof";
    /// <summary>lsof's options end here: the path after it is read as a path, whatever it starts with.</summary>
    private const string EndOfOptions = "--";

    public static IReadOnlyList<int> Of(string path, IEnumerable<int> candidates)
    {
        if (OperatingSystem.IsWindows())
        {
            return Windows(path);
        }
        return OperatingSystem.IsMacOS() ? Mac(path) : Linux(path, candidates);
    }

    /// <summary>Linux: a candidate holds the file when one of its open descriptors points at it.</summary>
    private static List<int> Linux(string path, IEnumerable<int> candidates)
    {
        var real = RealPath(path);
        return [.. candidates.Where(pid => Holds(pid, real))];
    }

    /// <summary>The path with every link on the way resolved, as /proc names what a process has open.</summary>
    private static string RealPath(string path)
    {
        var full = Path.GetFullPath(path);
        var current = Path.GetPathRoot(full) ?? "/";
        foreach (var part in full[current.Length..].Split(Path.DirectorySeparatorChar, StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, part);
            try
            {
                var link = Directory.Exists(current) ? Directory.ResolveLinkTarget(current, true) : File.ResolveLinkTarget(current, true);
                current = link?.FullName ?? current;
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                // Not resolvable: kept as it is.
            }
        }
        return current;
    }

    private static bool Holds(int pid, string path)
    {
        try
        {
            return Directory.EnumerateFileSystemEntries($"/proc/{pid}/fd")
                .Any(fd => new FileInfo(fd).LinkTarget is { } target && target == path);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>macOS: lsof's process ids (-t) for the file.</summary>
    private static List<int> Mac(string path)
    {
        var start = new ProcessStartInfo(Lsof) { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
        start.ArgumentList.Add("-t");
        start.ArgumentList.Add(EndOfOptions);
        start.ArgumentList.Add(path);
        try
        {
            using var lsof = Process.Start(start)!;
            var output = lsof.StandardOutput.ReadToEndAsync();
            if (!lsof.WaitForExit(LsofWait))
            {
                lsof.Kill();
                return [];
            }
            return [.. output.Result.Split('\n').Select(l => int.TryParse(l.Trim(), out var pid) ? pid : 0).Where(pid => pid > 0)];
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            return [];
        }
    }

    /// <summary>Windows: the Restart Manager's list of the processes using the file.</summary>
    [SupportedOSPlatform(OsPlatforms.Windows)]
    private static List<int> Windows(string path)
    {
        if (RmStartSession(out var session, 0, Guid.NewGuid().ToString()) != 0)
        {
            return [];
        }
        try
        {
            if (RmRegisterResources(session, 1, [path], 0, IntPtr.Zero, 0, null) != 0)
            {
                return [];
            }
            uint count = 0, reasons = 0;
            var result = RmGetList(session, out var needed, ref count, null, ref reasons);
            if (result != ErrorMoreData || needed == 0)
            {
                return [];
            }
            var found = new ProcessInfo[needed];
            count = needed;
            return RmGetList(session, out _, ref count, found, ref reasons) == 0 ? [.. found.Take((int)count).Select(p => p.Process.ProcessId)] : [];
        }
        finally
        {
            _ = RmEndSession(session);
        }
    }

    private const int ErrorMoreData = 234;
    private const int AppNameLength = 256;
    private const int ServiceNameLength = 64;

    [StructLayout(LayoutKind.Sequential)]
    private struct UniqueProcess
    {
        public int ProcessId;
        public FILETIME StartTime;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct ProcessInfo
    {
        public UniqueProcess Process;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = AppNameLength)] public string AppName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = ServiceNameLength)] public string ServiceName;
        public int ApplicationType;
        public uint AppStatus;
        public uint SessionId;
        [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
    }

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmStartSession(out uint session, int flags, string key);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmEndSession(uint session);

    [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
    private static extern int RmRegisterResources(uint session, uint files, string[] names, uint apps, IntPtr unique, uint services, string[]? serviceNames);

    [DllImport("rstrtmgr.dll")]
    private static extern int RmGetList(uint session, out uint needed, ref uint count, [In, Out] ProcessInfo[]? info, ref uint reasons);
}
