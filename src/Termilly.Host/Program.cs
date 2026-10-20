using System.Runtime.InteropServices;
using Termilly.Host;

// termilly-host: keeps Termilly's shells running while its window is closed (Settings › Workspaces).
// Started by the window when needed (or at sign-in, if chosen); one per user.
CrashLog.Install(CrashLog.HostFileName);
if (OperatingSystem.IsLinux())
{
    // Its own session, away from the window's: closing the terminal Termilly was started from (SIGHUP to its
    // session) or the window itself mustn't take the shells down.
    _ = setsid(); // fails only when it already leads a session, which is fine
}
return new Host().Run();

[DllImport("libc")]
static extern int setsid();
