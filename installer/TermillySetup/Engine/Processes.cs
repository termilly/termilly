using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;

namespace Termilly.Setup.Engine;

/// <summary>Termilly processes running from the install folder, and closing them.</summary>
internal static class Processes
{
    /// <summary>How long Termilly's windows get to close (and save) before what's left is ended, and each end.</summary>
    private static readonly TimeSpan CloseWait = TimeSpan.FromSeconds(10);
    private const int EndWaitMs = 5000;
    /// <summary>PROCESS_QUERY_LIMITED_INFORMATION: enough to read a process's path.</summary>
    private const int QueryLimitedInformation = 0x1000;

    /// <summary>Processes whose exe is in <paramref name="dir"/> (Termilly, its background host, the agent helpers).</summary>
    public static List<Process> InFolder(string dir)
    {
        var root = Path.GetFullPath(dir).TrimEnd('\\') + "\\";
        var found = new List<Process>();
        foreach (var process in Process.GetProcesses())
        {
            // Setup itself (and the copy that started it) is never one to close.
            if (ImagePath(process) is { } path && path.StartsWith(root, StringComparison.OrdinalIgnoreCase)
                && !Path.GetFileName(path).Equals(InstalledFiles.Setup, StringComparison.OrdinalIgnoreCase))
            {
                found.Add(process);
            }
            else
            {
                process.Dispose();
            }
        }
        return found;
    }

    /// <summary>Asks Termilly's windows to close (they save their session), then ends whatever is still running there.</summary>
    public static void CloseAll(string dir)
    {
        var running = InFolder(dir);
        if (running.Count == 0)
        {
            return;
        }
        Log.Write($"closing {running.Count} process(es) running from {dir}: {string.Join(", ", running.Select(p => p.ProcessName).Distinct())}");
        foreach (var p in running.Where(p => p.ProcessName.Equals(InstalledFiles.AppProcess, StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                p.CloseMainWindow();
            }
            catch (InvalidOperationException)
            {
            }
        }
        var until = DateTime.UtcNow + CloseWait;
        foreach (var p in running.Where(p => p.ProcessName.Equals(InstalledFiles.AppProcess, StringComparison.OrdinalIgnoreCase)))
        {
            try
            {
                p.WaitForExit((int)Math.Max(0, (until - DateTime.UtcNow).TotalMilliseconds));
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
            }
        }
        foreach (var p in InFolder(dir))
        {
            try
            {
                p.Kill();
                p.WaitForExit(EndWaitMs);
                Log.Write($"ended {p.ProcessName} ({p.Id})");
            }
            catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
            {
                Log.Write($"couldn't end {p.ProcessName}: {e.Message}");
            }
            finally
            {
                p.Dispose();
            }
        }
        foreach (var p in running)
        {
            p.Dispose();
        }
    }

    private static string? ImagePath(Process process)
    {
        IntPtr handle;
        try
        {
            handle = OpenProcess(QueryLimitedInformation, false, process.Id);
        }
        catch (InvalidOperationException)
        {
            return null;
        }
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

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(int access, bool inherit, int processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool QueryFullProcessImageName(IntPtr process, int flags, [Out] char[] name, ref int size);

    /// <summary>Room for a process's path (QueryFullProcessImageName), long paths included.</summary>
    private const int MaxPath = 1024;

    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);
}
