using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
using static Termilly.Pty.Unix.Native;

namespace Termilly.Pty.Unix;

/// <summary>
/// A pseudo terminal on Linux. The shell is started with posix_spawn in a session of its own, with the terminal's
/// other end as its stdin, stdout and stderr, so the terminal becomes its controlling terminal (Ctrl+C, job control
/// and window size work). posix_spawn rather than fork: forking a .NET process isn't safe.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class UnixPty : IPty
{
    /// <summary>Room for posix_spawn's opaque structures: file actions and signal sets, and its attributes.</summary>
    private const int SpawnStructSize = 256;
    private const int SpawnAttributesSize = 1024;
    /// <summary>Room for the terminal's device name (/dev/pts/N).</summary>
    private const int DeviceNameSize = 256;
    /// <summary>A wait status: the signal in the low 7 bits (0 when it exited), the exit code in the next byte.</summary>
    private const int SignalMask = 0x7f;
    private const int ExitCodeShift = 8;
    private const int ExitCodeMask = 0xff;
    /// <summary>Shells report a process killed by a signal as 128 + the signal.</summary>
    private const int SignalExitBase = 128;
    /// <summary>The signals a shell starts with at their defaults (the runtime ignores or handles some itself).</summary>
    private static readonly int[] DefaultSignals =
        [SIGHUP, SIGINT, SIGQUIT, SIGPIPE, SIGTERM, SIGCHLD, SIGTSTP, SIGTTIN, SIGTTOU, SIGUSR1, SIGUSR2, SIGWINCH];
    /// <summary>
    /// Variables other terminals set, by name and by prefix: started from one, Termilly inherits them, and they'd
    /// tell shells they run in that one (VTE's profile script then replaces Termilly's prompt marks with its own).
    /// </summary>
    private static readonly string[] OtherTerminalVariables =
        ["VTE_VERSION", "WINDOWID", "TERMINAL_EMULATOR", TerminalVariables.WindowsTerminalSession,
            TerminalVariables.WindowsTerminalProfile, "ALACRITTY_WINDOW_ID", "ALACRITTY_SOCKET"];
    private static readonly string[] OtherTerminalPrefixes =
        ["GNOME_TERMINAL_", "KONSOLE_", "KITTY_", "TILIX_", "WEZTERM_", "TERMINATOR_", "ITERM_"];
    private readonly int _master;
    private readonly TaskCompletionSource<int> _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private int _disposed;

    private UnixPty(int master, int pid)
    {
        _master = master;
        ProcessId = pid;
        // One stream each way over the same terminal (a duplicate descriptor, so each can close on its own).
        Output = new TerminalStream(new FileStream(new SafeFileHandle((IntPtr)master, ownsHandle: false), FileAccess.Read, 1));
        Input = new FileStream(new SafeFileHandle((IntPtr)dup(master), ownsHandle: true), FileAccess.Write, 1);
        var waiter = new Thread(WaitForExit) { IsBackground = true, Name = $"pty wait {pid}" };
        waiter.Start();
    }

    public int ProcessId { get; }
    public Stream Input { get; }
    public Stream Output { get; }
    public Task<int> Exited => _exited.Task;

    public static UnixPty Start(PtyOptions options)
    {
        var argv = CommandLine.Split(options.CommandLine);
        if (argv.Count == 0)
        {
            throw new ArgumentException("No command to start.", nameof(options));
        }

        var master = posix_openpt(O_RDWR | O_NOCTTY | O_CLOEXEC);
        if (master < 0 || grantpt(master) != 0 || unlockpt(master) != 0)
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "Couldn't open a pseudo terminal.");
        }
        SetSize(master, options.Columns, options.Rows);
        var error = Spawn(argv, SlaveName(master), options, out var pid);
        if (error != 0)
        {
            _ = close(master);
            throw new Win32Exception(error, $"Couldn't start {argv[0]}.");
        }
        return new UnixPty(master, pid);
    }

    /// <summary>
    /// Starts the program in a session of its own on the terminal's other end (<paramref name="slavePath"/>), in the
    /// working directory, with the shell's environment. Returns posix_spawn's error (0 when it started).
    /// </summary>
    private static int Spawn(List<string> argv, string slavePath, PtyOptions options, out int pid)
    {
        var actions = Marshal.AllocHGlobal(SpawnStructSize);
        var attr = Marshal.AllocHGlobal(SpawnAttributesSize);
        var signals = Marshal.AllocHGlobal(SpawnStructSize);
        try
        {
            FileActions(actions, slavePath, options.WorkingDirectory);
            Attributes(attr, signals);
            var argvPtrs = Strings(argv);
            var envPtrs = Strings(Environment(options.Environment));
            try
            {
                return posix_spawnp(out pid, argv[0], actions, attr, argvPtrs, envPtrs);
            }
            finally
            {
                FreeStrings(argvPtrs);
                FreeStrings(envPtrs);
            }
        }
        finally
        {
            _ = posix_spawn_file_actions_destroy(actions);
            _ = posix_spawnattr_destroy(attr);
            Marshal.FreeHGlobal(actions);
            Marshal.FreeHGlobal(attr);
            Marshal.FreeHGlobal(signals);
        }
    }

    /// <summary>The terminal as stdin, stdout and stderr, and the working directory when it exists.</summary>
    private static void FileActions(IntPtr actions, string slavePath, string? workingDirectory)
    {
        Check(posix_spawn_file_actions_init(actions));
        // After setsid (below), opening the terminal makes it the controlling terminal; then stdout and stderr.
        Check(posix_spawn_file_actions_addopen(actions, StandardInput, slavePath, O_RDWR, 0));
        Check(posix_spawn_file_actions_adddup2(actions, StandardInput, StandardOutput));
        Check(posix_spawn_file_actions_adddup2(actions, StandardInput, StandardError));
        if (workingDirectory is { Length: > 0 } cwd && Directory.Exists(cwd))
        {
            Check(posix_spawn_file_actions_addchdir_np(actions, cwd));
        }
    }

    /// <summary>A new session, and the signals a shell expects: none blocked, each at its default.</summary>
    private static void Attributes(IntPtr attr, IntPtr signals)
    {
        Check(posix_spawnattr_init(attr));
        // The runtime ignores or blocks some signals (SIGPIPE, …); the shell should start with the defaults.
        _ = sigemptyset(signals);
        Check(posix_spawnattr_setsigmask(attr, signals));
        foreach (var signal in DefaultSignals)
        {
            _ = sigaddset(signals, signal);
        }
        Check(posix_spawnattr_setsigdefault(attr, signals));
        Check(posix_spawnattr_setflags(attr, (short)(POSIX_SPAWN_SETSID | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF)));
    }

    public void Resize(int columns, int rows)
    {
        if (Volatile.Read(ref _disposed) == 0)
        {
            SetSize(_master, columns, rows); // the kernel tells the shell (SIGWINCH)
        }
    }

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) == 1)
        {
            return;
        }
        if (!_exited.Task.IsCompleted)
        {
            _ = kill(ProcessId, SIGHUP); // as a terminal window closing does
        }
        Input.Dispose();
        Output.Dispose();
        _ = close(_master);
    }

    private void WaitForExit()
    {
        while (true)
        {
            var result = waitpid(ProcessId, out var status, 0);
            if (result == ProcessId)
            {
                // Exited normally: its code; killed by a signal: 128 + the signal, as shells report it.
                var code = (status & SignalMask) == 0 ? (status >> ExitCodeShift) & ExitCodeMask : SignalExitBase + (status & SignalMask);
                _exited.TrySetResult(code);
                return;
            }
            if (result < 0 && Marshal.GetLastPInvokeError() != EINTR)
            {
                _exited.TrySetResult(-1); // someone else reaped it
                return;
            }
        }
    }

    /// <summary>
    /// The shell's variables, as NAME=value: this process's without other terminals' (see OtherTerminalVariables), a
    /// terminal that understands colour whatever started Termilly, then <paramref name="overrides"/>.
    /// </summary>
    internal static List<string> Environment(IReadOnlyDictionary<string, string>? overrides)
    {
        var vars = ShellEnvironment.Merge(overrides, StringComparer.Ordinal, own =>
        {
            foreach (var name in own.Keys.Where(InheritedFromTerminal).ToList())
            {
                own.Remove(name);
            }
            own[TerminalVariables.Term] = TerminalVariables.Xterm256Color;
            own[TerminalVariables.ColorTerm] = TerminalVariables.TrueColor;
        });
        return vars.Select(v => $"{v.Key}={v.Value}").ToList();
    }

    private static bool InheritedFromTerminal(string name) =>
        OtherTerminalVariables.Contains(name) || OtherTerminalPrefixes.Any(prefix => name.StartsWith(prefix, StringComparison.Ordinal));

    private static string SlaveName(int master)
    {
        var buffer = new byte[DeviceNameSize];
        if (ptsname_r(master, buffer, (nuint)buffer.Length) != 0)
        {
            throw new Win32Exception(Marshal.GetLastPInvokeError(), "Couldn't name the pseudo terminal.");
        }
        return System.Text.Encoding.UTF8.GetString(buffer, 0, Array.IndexOf(buffer, (byte)0));
    }

    private static void SetSize(int fd, int columns, int rows)
    {
        var size = new WinSize { Rows = (ushort)Math.Max(1, rows), Columns = (ushort)Math.Max(1, columns) };
        _ = ioctl(fd, TIOCSWINSZ, ref size); // a pty that's gone has no size to set
    }

    private static void Check(int error)
    {
        if (error != 0)
        {
            throw new Win32Exception(error);
        }
    }

    /// <summary>
    /// The terminal's output. Once the shell has exited and nothing holds the terminal open, reading fails with
    /// EIO: that's the end of the output, so it reads as 0 like the end of a file.
    /// </summary>
    private sealed class TerminalStream(Stream inner) : Stream
    {
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => false;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }

        public override int Read(byte[] buffer, int offset, int count)
        {
            try
            {
                return inner.Read(buffer, offset, count);
            }
            catch (IOException)
            {
                return 0;
            }
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                inner.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
