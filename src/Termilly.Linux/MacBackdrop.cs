using System.Runtime.Versioning;
using Termilly.Desktop;
using static Termilly.Linux.MacObjC;

namespace Termilly.Linux;

/// <summary>
/// A see-through window on macOS (Settings › Appearance › Background): its web view draws no background of its own, so
/// the desktop shows where the page lets it, and with Blur the system's blur (vibrancy) sits behind it. The windows
/// themselves are already see-through for their rounded corners (MacWindows).
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacBackdrop
{
    /// <summary>The effects macOS windows have: see-through, and blurred (vibrancy).</summary>
    public static IReadOnlyList<string> Effects { get; } = [BackgroundValues.Effect.None, BackgroundValues.Effect.Blur];

    private static bool _seeThrough;
    private static bool _blur;

    /// <summary>The blur view put behind each window's web view, by window, to take away again.</summary>
    private static readonly Dictionary<IntPtr, IntPtr> BlurViews = [];

    // NSVisualEffectView: blending behind the window, the window background's material, always active.
    private const nint BlendBehindWindow = 0;
    private const nint MaterialWindowBackground = 12;
    private const nint StateActive = 1;
    /// <summary>NSViewWidthSizable | NSViewHeightSizable: it follows the window's size.</summary>
    private const nint SizeWithWindow = 18;
    /// <summary>NSWindowBelow: added under the web view.</summary>
    private const nint Below = -1;

    /// <summary>What the windows have from now on; <see cref="Apply"/> each one.</summary>
    public static void Set(bool seeThrough, bool blur) => (_seeThrough, _blur) = (seeThrough, seeThrough && blur);

    /// <summary>A window and its web view as <see cref="Set"/> says: see-through or not, blurred or not.</summary>
    public static void Apply(IntPtr window, IntPtr view)
    {
        if (window == IntPtr.Zero || view == IntPtr.Zero)
        {
            return;
        }
        // WKWebView's own background (KVC, as Safari's web inspector does): off, the page's see-through colours show what's behind.
        Send(view, "setValue:forKey:", Send(Class("NSNumber"), "numberWithInteger:", (nint)(_seeThrough ? 0 : 1)), NsString("drawsBackground"));
        BlurViews.TryGetValue(window, out var effect);
        if (_blur && effect == IntPtr.Zero)
        {
            var content = Send(window, Cocoa.ContentView);
            effect = InitWithFrame(Send(Class("NSVisualEffectView"), Cocoa.Alloc), SendRect(content, Cocoa.Bounds), IntPtr.Zero);
            Send(effect, Cocoa.SetAutoresizingMask, SizeWithWindow);
            Send(effect, "setBlendingMode:", BlendBehindWindow);
            Send(effect, "setMaterial:", MaterialWindowBackground);
            Send(effect, "setState:", StateActive);
            Send(content, "addSubview:positioned:relativeTo:", effect, Below, view);
            BlurViews[window] = effect;
        }
        else if (!_blur && effect != IntPtr.Zero)
        {
            Send(effect, "removeFromSuperview");
            Send(effect, Cocoa.Release);
            BlurViews.Remove(window);
        }
    }

    /// <summary>See-through and blur changed: every window open follows (and those opened later, as MacWindows makes them).</summary>
    public static void SetAll(bool seeThrough, bool blur)
    {
        Set(seeThrough, blur);
        foreach (var (window, view) in MacWindows.All)
        {
            Apply(window, view);
        }
    }

    /// <summary>A window closed: its blur view goes with it.</summary>
    public static void Forget(IntPtr window) => BlurViews.Remove(window);
}
