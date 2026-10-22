using Microsoft.Extensions.DependencyInjection;
using Termilly.Desktop;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// Termilly on Linux: a Photino window (WebKitGTK, <see cref="LinuxWindow"/>) showing the same page as on Windows,
/// talking to <see cref="LinuxHost"/>. As on Windows the window has no title bar or frame of its own: the page draws
/// them, and its title bar and edges move and resize the window (GtkWindow).
/// </summary>
internal static class Program
{
    /// <summary>How long a second start waits for the running Termilly (perhaps still loading) to take its folder.</summary>
    private static readonly TimeSpan HandOverTimeout = TimeSpan.FromSeconds(30);

    [STAThread]
    private static int Main(string[] args)
    {
        CrashLog.Install();
        // One Termilly per data folder, as on Windows: started again (perhaps with a folder), it hands over to the
        // one already running, even while that one is still loading.
        var folder = OpenFolder.Argument(args);
        using var instance = OpenFolder.ClaimInstance(out var first);
        if (!first && OpenFolder.TryForward(folder, HandOverTimeout))
        {
            return 0;
        }

        // The window's app id (Wayland) and class (X11): desktops match it to termilly.desktop for the icon and name.
        GtkWindow.SetProgramName(GtkWindow.ProgramId, GtkWindow.Title);

        var window = new LinuxWindow();
        var platform = new LinuxPlatform(window.Send, folder);
        // The composition root on Linux: the shared services, and Linux's own (LinuxPlatform, the keyring).
        using var services = new ServiceCollection()
            .AddTermilly()
            .AddPlatform(platform)
            .AddSingleton<ICredentialStore, LinuxKeyringStore>()
            .AddSingleton<IFontCatalog, LinuxFonts>()
            .AddSingleton<IUpdateInstaller, LinuxUpdateInstaller>()
            .BuildServiceProvider();
        window.Run(platform, services.GetRequiredService<WindowTheme>(), services.GetRequiredService<PageChannel>(), services.GetRequiredService<PageHost>(),
            services.GetRequiredService<QuitGate>());
        return 0;
    }
}
