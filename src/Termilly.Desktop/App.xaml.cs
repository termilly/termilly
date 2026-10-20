using System.Windows;
using Termilly.Desktop.Services;

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
        MainWindow = new MainWindow();
        MainWindow.Show();
    }
}
