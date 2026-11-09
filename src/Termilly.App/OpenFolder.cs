using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Starting Termilly when it's already running, and "Open in Termilly" (the Explorer menu and <c>termilly
/// &lt;folder&gt;</c>): <c>Termilly.exe [--open "C:\some\folder"]</c>. The Termilly already running (one per data
/// folder) opens a terminal there, or brings forward one already in that folder, and comes to the front; only when
/// none is running does this one start.
/// </summary>
internal static class OpenFolder
{
    /// <summary>How long to wait before trying the running Termillys again.</summary>
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(250);
    /// <summary>How long a pipe may take to connect, in milliseconds.</summary>
    private const int ConnectTimeout = 300;
    /// <summary>How long the running Termilly may take to answer: its window may need a moment.</summary>
    private static readonly TimeSpan ReplyTimeout = TimeSpan.FromSeconds(8);

    /// <summary>The folder asked for: --open DIR, or a lone argument that's an existing folder; null otherwise.</summary>
    public static string? Argument(IReadOnlyList<string> args)
    {
        var folder = args switch
        {
            ["--open", var dir, ..] => dir,
            [var dir] when !dir.StartsWith('-') => dir,
            _ => null,
        };
        if (string.IsNullOrWhiteSpace(folder))
        {
            return null;
        }
        // Explorer's %V for a drive is "C:\"; quoting can leave a trailing quote behind ("C:\"" arrives as C:").
        if (OperatingSystem.IsWindows())
        {
            folder = folder.Trim().TrimEnd('"');
            if (folder.Length == 2 && folder[1] == ':')
            {
                folder += "\\";
            }
        }
        return Directory.Exists(folder) ? Path.TrimEndingDirectorySeparator(Path.GetFullPath(folder)) : null;
    }

    /// <summary>
    /// One Termilly per data folder (a test copy with its own TERMILLY_DATA_DIR still runs alongside). Held by the
    /// Termilly that started first, for as long as it runs.
    /// </summary>
    public static IDisposable? ClaimInstance(out bool first, string? dataDirectory = null)
    {
        if (!OperatingSystem.IsWindows())
        {
            return LockFile(dataDirectory ?? AppPaths.DataDirectory, out first);
        }
        var folder = (dataDirectory ?? AppPaths.DataDirectory).ToLowerInvariant();
        var key = Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(Encoding.UTF8.GetBytes(folder)))[..16];
        try
        {
            return new Mutex(initiallyOwned: true, $@"Local\Termilly-{key}", out first);
        }
        catch (Exception e) when (e is UnauthorizedAccessException or WaitHandleCannotBeOpenedException or IOException)
        {
            first = true; // can't tell: start as before
            return null;
        }
    }

    /// <summary>
    /// Off Windows: an open, locked file in the data folder (FileShare.None takes an flock there). The system lets go
    /// of it when this Termilly exits, however it ends.
    /// </summary>
    private static FileStream? LockFile(string folder, out bool first)
    {
        first = true;
        string path;
        try
        {
            path = Path.Combine(Directory.CreateDirectory(folder).FullName, "instance.lock");
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null; // can't tell: start as before
        }
        try
        {
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (IOException)
        {
            first = false; // another Termilly holds it
            return null;
        }
    }

    /// <summary>
    /// Hands the start-up to the Termilly already running: a terminal in <paramref name="folder"/> (or the one already
    /// there), or just its window to the front. Keeps trying for <paramref name="wait"/>, because that Termilly may
    /// itself be starting. True when it took it.
    /// </summary>
    public static bool TryForward(string? folder, TimeSpan wait)
    {
        var request = folder is null
            ? new JsonObject { [ApiFields.Version] = AgentHooks.Version, [ApiFields.Method] = ApiMethods.Activate }
            : new JsonObject { [ApiFields.Version] = AgentHooks.Version, [ApiFields.Method] = ApiMethods.Open, [ApiFields.Cwd] = folder, [ApiFields.Reuse] = true, [ApiFields.Activate] = true };
        var line = request.ToJsonString();
        var until = DateTime.UtcNow + wait;
        do
        {
            foreach (var (name, pid) in Candidates())
            {
                // Explorer (or the shell) gave this process the right to take the foreground; pass it on.
                if (OperatingSystem.IsWindows())
                {
                    AllowSetForegroundWindow(pid == 0 ? AsfwAny : pid);
                }
                if (Send(name, line) is { } reply && reply.Contains(HookReplies.OkMark, StringComparison.Ordinal))
                {
                    return true;
                }
            }
            Thread.Sleep(RetryDelay);
        }
        while (DateTime.UtcNow < until);
        return false;
    }

    /// <summary>The pipes of the other running Termillys: the background host's fixed one, then each window's own.</summary>
    private static List<(string Name, int Pid)> Candidates()
    {
        var pipes = new List<(string Name, int Pid)> { (PipeNames.Main, 0) };
        try
        {
            var self = Environment.ProcessId;
            pipes.AddRange(Process.GetProcessesByName(Path.GetFileNameWithoutExtension(Environment.ProcessPath) ?? Product.Name)
                .Where(p => p.Id != self).Select(p => (PipeNames.ForProcess(p.Id), p.Id)));
        }
        catch (InvalidOperationException)
        {
        }
        return pipes;
    }

    private static string? Send(string pipeName, string message)
    {
        try
        {
            using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.CurrentUserOnly);
            pipe.Connect(ConnectTimeout);
            var bytes = Encoding.UTF8.GetBytes(message + "\n");
            pipe.Write(bytes);
            pipe.Flush();
            using var reader = new StreamReader(pipe, Encoding.UTF8);
            var line = reader.ReadLineAsync();
            return line.Wait(ReplyTimeout) ? line.Result : null; // the window may need a moment
        }
        catch (Exception e) when (e is IOException or TimeoutException or UnauthorizedAccessException or InvalidOperationException)
        {
            return null;
        }
    }

    private const int AsfwAny = -1;

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AllowSetForegroundWindow(int processId);
}
