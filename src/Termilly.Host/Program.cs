using System.Runtime.InteropServices;
using Termilly.Host;
using Termilly.Pty;

// termilly-host: keeps Termilly's shells running while its window is closed (Settings › Workspaces).
// Started by the window when needed (or at sign-in, if chosen); one per user.
CrashLog.Install(CrashLog.HostFileName);
QuietErrors.Install();
// One host per user: a window that found the host busy (an earlier window still closing) starts another, which must
// leave, or the shells split between two hosts and "Stop background shells" ends only one of them. Global on Windows,
// so a second host in another sign-in session of the same user is kept out too.
using var only = SingleInstance.Claim($@"Global\{HostProtocol.PipeName}", Path.Combine(Path.GetTempPath(), $"{HostProtocol.PipeName}.lock"), out var first);
if (!first)
{
    return 0;
}
if (!OperatingSystem.IsWindows())
{
    // Its own session, away from the window's: closing the terminal Termilly was started from (SIGHUP to its
    // session) or the window itself mustn't take the shells down.
    _ = setsid(); // fails only when it already leads a session, which is fine
}
return new Host().Run();

[DllImport("libc")]
static extern int setsid();
