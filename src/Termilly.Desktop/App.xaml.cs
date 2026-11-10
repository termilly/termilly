using System.Windows;
using Termilly.Desktop.Services;
using Termilly.Shared;

namespace Termilly.Desktop;

public partial class App : Application
{
    /// <summary>How long a second start waits for the running Termilly (perhaps still loading) to take its folder.</summary>
    private static readonly TimeSpan HandOverTimeout = TimeSpan.FromSeconds(30);

    /// <summary>Held while this Termilly runs: the next one to start hands over to it (see <see cref="OpenFolder"/>).</summary>
    private static IDisposable? _instance;

    /// <summary>A folder to open a terminal in once the page is up ("Open in Termilly"; see <see cref="OpenFolder"/>).</summary>
    public static string? StartFolder { get; private set; }

    protected override void OnStartup(StartupEventArgs e)
    {
        CrashLog.Install();
        QuietErrors.Install(); // before anything starts a program in the background
        base.OnStartup(e);
        var folder = OpenFolder.Argument(e.Args);
        _instance = OpenFolder.ClaimInstance(out var first);
        // Another Termilly has this data folder (perhaps still starting): it opens the folder or comes to the front.
        if (!first && OpenFolder.TryForward(folder, HandOverTimeout))
        {
            Shutdown();
            return;
        }
        StartFolder = folder;
        // Only the Termilly that really holds the instance updates: one that couldn't tell starts as before.
        if (first && _instance is not null && UpdateAtStart() is { } update)
        {
            _ = StartAfterUpdateAsync(update);
            return;
        }
        OpenMainWindow();
    }

    private void OpenMainWindow()
    {
        var window = new MainWindow();
        MainWindow = window;
        // Signing out or shutting down never waits on a question or hides in the tray.
        SessionEnding += (_, _) => window.AllowQuit();
        window.Show();
    }

    /// <summary>
    /// What an update at start works with, when the user turned it on and this is an install it can update: Windows'
    /// per-user installs for now (an install for all users needs an administrator, and keeps today's notice).
    /// </summary>
    private static (StartupUpdateParts Parts, ISettingsStore Settings)? UpdateAtStart()
    {
        var settings = new SettingsStore();
        var options = settings.Current.Interface;
        if (!options.CheckForUpdates || !options.InstallUpdatesOnStart || WindowsUpdateInstaller.Installed() is not { AllUsers: false } installed)
        {
            return null;
        }
        var download = UpdateDownload.Create();
        var installer = new WindowsUpdateInstaller();
        return (new StartupUpdateParts(
            installed.Dir,
            AppVersion.Current,
            UpdateCheck.FetchAsync,
            latest => UpdateCheck.Package(latest, linux: false),
            download.DownloadAsync,
            UpdateDownload.IsIntact,
            HostClient.HasKeptShells,
            file => installer.InstallAsync(file, CancellationToken.None),
            () => DateTimeOffset.Now,
            Task.Delay), settings);
    }

    /// <summary>
    /// Shows the update's loader and runs it; Termilly then quits for setup to install the new version, or opens as it
    /// would have, the main window taking the loader's place. An update that goes wrong never keeps Termilly from
    /// starting.
    /// </summary>
    private async Task StartAfterUpdateAsync((StartupUpdateParts Parts, ISettingsStore Settings) update)
    {
        var gate = new UpdateGateWindow(update.Settings);
        gate.Show();
        var handedOff = false;
        try
        {
            handedOff = await new StartupUpdateGate(update.Parts, gate).RunAsync();
        }
#pragma warning disable CA1031 // a fault in the update must not stop Termilly from starting: it's logged and Termilly starts
        catch (Exception error)
#pragma warning restore CA1031
        {
            CrashLog.Caught(error);
        }
        if (handedOff)
        {
            gate.Finish();
            Shutdown();
            return;
        }
        OpenMainWindow();
        gate.Finish();
    }
}
