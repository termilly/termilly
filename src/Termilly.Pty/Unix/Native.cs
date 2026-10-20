using System.Runtime.InteropServices;

namespace Termilly.Pty.Unix;

/// <summary>The libc calls <see cref="UnixPty"/> uses, with Linux's constants (x86-64 and arm64 share these).</summary>
internal static class Native
{
    private const string Libc = "libc";

    public const int O_RDWR = 2;
    /// <summary>The standard descriptors: stdin, stdout and stderr.</summary>
    public const int StandardInput = 0;
    public const int StandardOutput = 1;
    public const int StandardError = 2;
    public const int O_NOCTTY = 0x100;
    public const int O_CLOEXEC = 0x80000;
    public const ulong TIOCSWINSZ = 0x5414;
    public const int EINTR = 4;

    public const int POSIX_SPAWN_SETSIGDEF = 0x04;
    public const int POSIX_SPAWN_SETSIGMASK = 0x08;
    public const int POSIX_SPAWN_SETSID = 0x80;

    public const int SIGHUP = 1;
    public const int SIGINT = 2;
    public const int SIGQUIT = 3;
    public const int SIGUSR1 = 10;
    public const int SIGUSR2 = 12;
    public const int SIGPIPE = 13;
    public const int SIGTERM = 15;
    public const int SIGCHLD = 17;
    public const int SIGTSTP = 20;
    public const int SIGTTIN = 21;
    public const int SIGTTOU = 22;
    public const int SIGWINCH = 28;

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
    public static extern int ioctl(int fd, ulong request, ref WinSize size);

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
