using System.Runtime.InteropServices;

/// <summary>
/// Windows: the programs Termilly starts in the background (git for a terminal's folder, wsl.exe, docker) fail
/// quietly, as on Linux and macOS, instead of leaving a box nobody asked for ("git.exe - Application Error: unable to
/// start correctly" when Windows is out of memory). The error mode is inherited by every program a process starts, so
/// it's set once for Termilly. Shells start with Windows' own (ConPty: CREATE_DEFAULT_ERROR_MODE), so a program run
/// in a terminal still says why it can't start. Nothing elsewhere.
/// </summary>
internal static class QuietErrors
{
    /// <summary>SEM_FAILCRITICALERRORS, SEM_NOGPFAULTERRORBOX and SEM_NOOPENFILEERRORBOX.</summary>
    private const uint Quiet = 0x0001 | 0x0002 | 0x8000;

    public static void Install()
    {
        if (OperatingSystem.IsWindows())
        {
            _ = SetErrorMode(GetErrorMode() | Quiet); // the mode before: not needed
        }
    }

    [DllImport("kernel32.dll")]
    private static extern uint SetErrorMode(uint mode);

    [DllImport("kernel32.dll")]
    private static extern uint GetErrorMode();
}
