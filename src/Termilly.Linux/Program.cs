using System.Runtime.Versioning;
using Microsoft.Extensions.DependencyInjection;
using Termilly.Desktop;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// Termilly on Linux and macOS: a Photino window (WebKitGTK, or WKWebView on macOS; <see cref="LinuxWindow"/>) showing the same page as on Windows,
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
        PipeFiles.ClearDead(); // socket files of Termillys gone

        var window = new LinuxWindow();
        PhotinoPlatform platform;
        IServiceCollection services;
        if (OperatingSystem.IsMacOS())
        {
            services = MacServices(window, folder, out platform);
        }
        else if (OperatingSystem.IsLinux())
        {
            services = LinuxServices(window, folder, out platform);
        }
        else
        {
            throw new PlatformNotSupportedException("This build of Termilly runs on Linux and macOS.");
        }
        using var provider = services.BuildServiceProvider();
        // The whole app's size (Settings' zoom), from the start and as it changes.
        var settings = provider.GetRequiredService<ISettingsStore>();
        window.SetZoom(settings.Current.Interface.Zoom);
        settings.Saved += _ => window.SetZoom(settings.Current.Interface.Zoom);
        if (OperatingSystem.IsLinux() && settings.Current.Interface.RunAsX11)
        {
            GtkWindow.UseX11(); // before the window opens GTK
        }
        window.Run(platform, provider.GetRequiredService<WindowTheme>(), provider.GetRequiredService<PageChannel>(), provider.GetRequiredService<PageHost>(),
            provider.GetRequiredService<QuitGate>());
        return 0;
    }

    /// <summary>The composition root on Linux: the shared services, and Linux's own (LinuxPlatform, the keyring).</summary>
    [SupportedOSPlatform("linux")]
    private static IServiceCollection LinuxServices(LinuxWindow window, string? folder, out PhotinoPlatform platform)
    {
        // The window's app id (Wayland) and class (X11): desktops match it to termilly.desktop for the icon and name.
        GtkWindow.SetProgramName(GtkWindow.ProgramId, GtkWindow.Title);
        platform = new LinuxPlatform(window.Send, folder);
        return new ServiceCollection()
            .AddTermilly()
            .AddPlatform(platform)
            .AddSingleton<IClipboardWatch, LinuxClipboard>()
            .AddSingleton<ICredentialStore, LinuxKeyringStore>()
            .AddSingleton<IFontCatalog, LinuxFonts>()
            .AddSingleton<IAudioOutputs, LinuxAudio>()
            .AddSingleton<IUpdateInstaller, LinuxUpdateInstaller>();
    }

    /// <summary>
    /// The composition root on macOS: the shared services, and macOS's own (MacPlatform, the keychain). No update
    /// installer of its own yet: Updates offers none on macOS (there's no package), so the Linux one is never asked.
    /// </summary>
    [SupportedOSPlatform("macos")]
    private static IServiceCollection MacServices(LinuxWindow window, string? folder, out PhotinoPlatform platform)
    {
        platform = new MacPlatform(window.Send, folder, new ProcessRunner());
        var onWindow = platform.OnWindowThread;
        return new ServiceCollection()
            .AddTermilly()
            .AddPlatform(platform)
            .AddSingleton<IClipboardWatch>(new MacClipboard(onWindow))
            .AddSingleton<ICredentialStore, MacKeychainStore>()
            .AddSingleton<IFontCatalog, MacFonts>()
            .AddSingleton<IAudioOutputs, MacAudio>()
            .AddSingleton<IUpdateInstaller, LinuxUpdateInstaller>();
    }
}
