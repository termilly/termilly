using System.Globalization;
using System.Runtime.InteropServices;

namespace Termilly.Pty.Unix;

/// <summary>The user this process runs as on Linux and macOS, by id: what keeps two users' files and pipes apart.</summary>
public static class UnixUser
{
    /// <summary>The effective user id, as the system writes it (claude-501, termilly-host-501).</summary>
    public static string Id => geteuid().ToString(CultureInfo.InvariantCulture);

    [DllImport("libc")]
    private static extern uint geteuid();
}
