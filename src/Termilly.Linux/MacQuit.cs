using System.Runtime.Versioning;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// macOS: quitting the app (Cmd+Q, the Dock's Quit, logging out) goes the way closing its window does. Photino's app
/// delegate has no answer of its own to whether the app may quit, so it quit at once: nothing asked, no last snapshot.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacQuit
{
    private static readonly ShouldTerminate OnShouldTerminate = Terminating;
    private delegate nuint ShouldTerminate(IntPtr self, IntPtr selector, IntPtr application);
    /// <summary>NSApplicationTerminateReply: NSTerminateCancel and NSTerminateNow.</summary>
    private const nuint TerminateCancel = 0;
    private const nuint TerminateNow = 1;
    private static Func<bool>? _mayQuit;

    /// <summary>
    /// Quitting the app (Cmd+Q, the Dock's Quit, logging out) asks <paramref name="mayQuit"/> first: true quits now;
    /// false keeps it running, and <paramref name="mayQuit"/> closes the main window once it may (asking first while
    /// something runs, as its Close does), which then quits it.
    /// </summary>
    public static void Hook(Func<bool> mayQuit)
    {
        _mayQuit = mayQuit;
        var application = Send(Class(Cocoa.Application), Cocoa.SharedApplication);
        var appDelegate = Send(application, "delegate");
        if (ClassOf(appDelegate) is var cls && cls != IntPtr.Zero)
        {
            AddMethod(cls, "applicationShouldTerminate:", OnShouldTerminate, "Q@:@");
        }
    }

    private static nuint Terminating(IntPtr self, IntPtr selector, IntPtr application) =>
        _mayQuit is null || _mayQuit() ? TerminateNow : TerminateCancel;
}
