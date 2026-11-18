using Microsoft.Web.WebView2.Core;

namespace Termilly.Desktop;

/// <summary>
/// The terminal's right-click Paste reads the clipboard, which WebView2 would otherwise ask about each time. Only
/// Termilly's own page gets it (a plugin's sandboxed frame has an opaque origin of its own).
/// </summary>
internal static class ClipboardReadPermission
{
    /// <summary>The address of the empty page window.open starts a detached window with, before the page fills it.</summary>
    private const string BlankPage = "about:blank";

    /// <summary>The main window's browser: its own page only.</summary>
    public static void AllowForPage(CoreWebView2 core, string hostName) =>
        core.PermissionRequested += (_, e) => Decide(e, hostName, blankIsPage: false);

    /// <summary>
    /// A detached window's browser: its own page, and the empty page it's opened with, which only Termilly's page can
    /// open (MainWindow.OnNewWindowRequested) and which it fills with its own elements.
    /// </summary>
    public static void AllowForDetached(CoreWebView2 core, string hostName) =>
        core.PermissionRequested += (_, e) => Decide(e, hostName, blankIsPage: true);

    private static void Decide(CoreWebView2PermissionRequestedEventArgs e, string hostName, bool blankIsPage)
    {
        if (e.PermissionKind != CoreWebView2PermissionKind.ClipboardRead)
        {
            return;
        }
        if (e.Uri.StartsWith($"https://{hostName}/", StringComparison.OrdinalIgnoreCase))
        {
            e.State = CoreWebView2PermissionState.Allow;
        }
        else if (blankIsPage && string.Equals(e.Uri, BlankPage, StringComparison.OrdinalIgnoreCase))
        {
            // For this window only: the browser profile doesn't keep it for every blank page.
            e.SavesInProfile = false;
            e.State = CoreWebView2PermissionState.Allow;
        }
    }
}
