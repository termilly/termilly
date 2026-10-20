namespace Termilly.Pty;

/// <summary>Starts a process in a pseudo terminal: ConPTY on Windows, a Unix pseudo terminal on Linux.</summary>
public static class PseudoTerminal
{
    public static IPty Start(PtyOptions options)
    {
        if (OperatingSystem.IsWindows())
        {
            return Windows.ConPty.Start(options);
        }
        if (OperatingSystem.IsLinux())
        {
            return Unix.UnixPty.Start(options);
        }
        throw new PlatformNotSupportedException("Termilly's terminals run on Windows and Linux.");
    }
}
