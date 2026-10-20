using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.Versioning;
using Termilly.Desktop;
using Termilly.Pty;

namespace Termilly.Core.Tests;

/// <summary>
/// The background host on Linux: a shell started in it keeps running when the window goes, and a window that comes
/// back takes it over, with the output it missed. Runs the host as the app ships it, on a pipe of its own
/// (TERMILLY_HOST_PIPE), so it never meets the user's own host.
/// </summary>
[SupportedOSPlatform("linux")] // the test itself returns early elsewhere
public sealed class BackgroundHostTests
{
    // The tests' own configuration (bin/<Debug|Release>/net10.0), so a Release test run finds the Release host.
    private static readonly string Configuration =
        Path.GetFileName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory)))!;

    private static readonly string HostExe = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
        "src", "Termilly.Linux", "bin", Configuration, "net10.0", "host", "termilly-host"));

    [Fact]
    public void A_shell_outlives_the_window_and_the_next_window_takes_it_back()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        Assert.True(File.Exists(HostExe), HostExe);
        Environment.SetEnvironmentVariable("TERMILLY_HOST_PIPE", $"termilly-host-test-{Guid.NewGuid():N}");
        using var host = Process.Start(new ProcessStartInfo(HostExe) { UseShellExecute = false })!;
        try
        {
            // The host runs in a session of its own: closing the terminal Termilly was started from doesn't end it.
            Assert.True(Until(() => SessionOf(host.Id) == host.Id));

            var first = Connect();
            var seen = new ConcurrentQueue<string>();
            var shell = first.Start("t1", new PtyOptions("/bin/sh", 80, 24, "/tmp"), seen.Enqueue, _ => { }, m => seen.Enqueue($"FAILED {m}"));
            Assert.True(shell.ProcessId > 0);
            shell.Write("echo one-$((1+1))\n");
            Assert.True(Until(() => string.Concat(seen).Contains("one-2", StringComparison.Ordinal)), string.Concat(seen));
            first.Dispose(); // the window closes; the shell stays with the host

            shell.Write("ignored"); // a closed window's session says nothing more
            Assert.True(Directory.Exists($"/proc/{shell.ProcessId}"), "the shell ended with the window");

            var second = Connect();
            Assert.True(second.Running.TryGetValue("t1", out var kept) && kept.Alive && kept.Pid == shell.ProcessId);
            var replayed = new ConcurrentQueue<string>();
            var taken = second.Attach("t1", kept.Pid, 100, 30, replayed.Enqueue, _ => { });
            Assert.True(Until(() => string.Concat(replayed).Contains("one-2", StringComparison.Ordinal)), "no replay of what it missed");
            taken.Write("echo two-$((2+2))\n");
            Assert.True(Until(() => string.Concat(replayed).Contains("two-4", StringComparison.Ordinal)), string.Concat(replayed));

            second.Shutdown(); // Settings › Stop background shells
            Assert.True(host.WaitForExit(5000));
            Assert.True(Until(() => !Directory.Exists($"/proc/{shell.ProcessId}") || File.ReadAllText($"/proc/{shell.ProcessId}/stat").Contains(") Z", StringComparison.Ordinal)));
        }
        finally
        {
            if (!host.HasExited)
            {
                host.Kill(entireProcessTree: true);
            }
            Environment.SetEnvironmentVariable("TERMILLY_HOST_PIPE", null);
        }
    }

    private static HostClient Connect()
    {
        HostClient? client = null;
        Assert.True(Until(() => (client = HostClient.Connect()) is not null), "couldn't reach the host");
        return client!;
    }

    /// <summary>The session a process is in (/proc/&lt;pid&gt;/stat, the field after the process group).</summary>
    private static int SessionOf(int pid)
    {
        var stat = File.ReadAllText($"/proc/{pid}/stat");
        return int.Parse(stat[(stat.LastIndexOf(')') + 2)..].Split(' ')[3], System.Globalization.CultureInfo.InvariantCulture);
    }

    private static bool Until(Func<bool> condition, int seconds = 10)
    {
        var until = DateTime.UtcNow.AddSeconds(seconds);
        while (DateTime.UtcNow < until)
        {
            if (condition())
            {
                return true;
            }
            Thread.Sleep(100);
        }
        return condition();
    }
}
