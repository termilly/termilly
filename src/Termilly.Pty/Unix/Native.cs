using System.Runtime.InteropServices;

namespace Termilly.Pty.Unix;

/// <summary>
/// The libc calls <see cref="UnixPty"/> uses, with Linux's or macOS's constants (where they differ, each OS's
/// headers are quoted; x86-64 and arm64 share them on both).
/// </summary>
internal static class Native
{
    private const string Libc = "libc";
    private static readonly bool Mac = OperatingSystem.IsMacOS();

    public const int O_RDWR = 2;
    /// <summary>The standard descriptors: stdin, stdout and stderr.</summary>
    public const int StandardInput = 0;
    public const int StandardOutput = 1;
    public const int StandardError = 2;
    public static readonly int O_NOCTTY = Mac ? 0x20000 : 0x100;
    public static readonly int O_CLOEXEC = Mac ? 0x1000000 : 0x80000;
    /// <summary>_IOW('t', 103, struct winsize) on macOS.</summary>
    public static readonly ulong TIOCSWINSZ = Mac ? 0x80087467 : 0x5414;
    public const int EINTR = 4;

    public const int POSIX_SPAWN_SETSIGDEF = 0x04;
    public const int POSIX_SPAWN_SETSIGMASK = 0x08;
    public static readonly int POSIX_SPAWN_SETSID = Mac ? 0x400 : 0x80;

    public const int SIGHUP = 1;
    public const int SIGINT = 2;
    public const int SIGQUIT = 3;
    public static readonly int SIGUSR1 = Mac ? 30 : 10;
    public static readonly int SIGUSR2 = Mac ? 31 : 12;
    public const int SIGPIPE = 13;
    public const int SIGTERM = 15;
    public static readonly int SIGCHLD = Mac ? 20 : 17;
    public static readonly int SIGTSTP = Mac ? 18 : 20;
    public const int SIGTTIN = 21;
    public const int SIGTTOU = 22;
    public const int SIGWINCH = 28;

    /// <summary>
    /// Sets the terminal's size. ioctl is variadic: on Apple's arm64 a variadic argument goes on the stack, not in a
    /// register as P/Invoke passes it, so there the size is pushed past the eight argument registers.
    /// </summary>
    public static int SetWindowSize(int fd, ref WinSize size) =>
        Mac && RuntimeInformation.ProcessArchitecture == Architecture.Arm64
            ? ioctl_stacked(fd, TIOCSWINSZ, 0, 0, 0, 0, 0, 0, ref size)
            : ioctl(fd, TIOCSWINSZ, ref size);

    [DllImport(Libc, EntryPoint = "ioctl", SetLastError = true)]
    private static extern int ioctl_stacked(int fd, ulong request, long r2, long r3, long r4, long r5, long r6, long r7, ref WinSize size);

    [StructLayout(LayoutKind.Sequential)]
    public struct WinSize
    {
        public ushort Rows;
        public ushort Columns;
        public ushort XPixels;
        public ushort YPixels;
    }

    [DllImport(Libc, SetLastError = true)]
    public static extern int posix_openpt(int flags);

    [DllImport(Libc, SetLastError = true)]
    public static extern int grantpt(int fd);

    [DllImport(Libc, SetLastError = true)]
    public static extern int unlockpt(int fd);

    [DllImport(Libc, SetLastError = true)]
    public static extern int ptsname_r(int fd, byte[] buffer, nuint length);

    [DllImport(Libc, SetLastError = true)]
    private static extern int ioctl(int fd, ulong request, ref WinSize size);

    /// <summary>open without a mode (its variadic part), which only creating a file needs.</summary>
    [DllImport(Libc, SetLastError = true)]
    public static extern int open([MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags);

    [DllImport(Libc, SetLastError = true)]
    public static extern int dup(int fd);

    [DllImport(Libc, SetLastError = true)]
    public static extern int close(int fd);

    [DllImport(Libc, SetLastError = true)]
    public static extern int kill(int pid, int signal);

    [DllImport(Libc, SetLastError = true)]
    public static extern int waitpid(int pid, out int status, int options);

    [DllImport(Libc)]
    public static extern int sigemptyset(IntPtr set);

    [DllImport(Libc)]
    public static extern int sigaddset(IntPtr set, int signal);

    // posix_spawn* return the error number rather than setting errno.

    [DllImport(Libc)]
    public static extern int posix_spawn_file_actions_init(IntPtr actions);

    [DllImport(Libc)]
    public static extern int posix_spawn_file_actions_destroy(IntPtr actions);

    [DllImport(Libc)]
    public static extern int posix_spawn_file_actions_addopen(IntPtr actions, int fd, [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mode);

    [DllImport(Libc)]
    public static extern int posix_spawn_file_actions_adddup2(IntPtr actions, int fd, int newFd);

    [DllImport(Libc)]
    public static extern int posix_spawn_file_actions_addchdir_np(IntPtr actions, [MarshalAs(UnmanagedType.LPUTF8Str)] string path);

    [DllImport(Libc)]
    public static extern int posix_spawnattr_init(IntPtr attr);

    [DllImport(Libc)]
    public static extern int posix_spawnattr_destroy(IntPtr attr);

    [DllImport(Libc)]
    public static extern int posix_spawnattr_setflags(IntPtr attr, short flags);

    [DllImport(Libc)]
    public static extern int posix_spawnattr_setsigmask(IntPtr attr, IntPtr set);

    [DllImport(Libc)]
    public static extern int posix_spawnattr_setsigdefault(IntPtr attr, IntPtr set);

    [DllImport(Libc)]
    public static extern int posix_spawnp(out int pid, [MarshalAs(UnmanagedType.LPUTF8Str)] string file, IntPtr actions, IntPtr attr,
        IntPtr[] argv, IntPtr[] envp);

    /// <summary>A null-terminated array of UTF-8 strings (argv, envp); free it with <see cref="FreeStrings"/>.</summary>
    public static IntPtr[] Strings(IReadOnlyList<string> values) =>
        [.. values.Select(Marshal.StringToCoTaskMemUTF8), IntPtr.Zero];

    public static void FreeStrings(IntPtr[] strings)
    {
        foreach (var s in strings)
        {
            Marshal.FreeCoTaskMem(s);
        }
    }
}
