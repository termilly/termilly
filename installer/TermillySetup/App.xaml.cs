using System;
using System.Windows;

namespace Termilly.Setup;

public partial class App : Application
{
    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        if (SetupApp.Has("--quiet"))
        {
            Shutdown(Engine.Quiet.Run()); // no window: scripts and IT tools (Engine/Quiet.cs)
            return;
        }
        // A bug in setup still ends with words and a log, not a vanished window.
        DispatcherUnhandledException += (_, args) =>
        {
            Engine.Log.Write($"unexpected error: {args.Exception}");
            MessageBox.Show($"Setup ran into an unexpected problem and has to stop:\n\n{args.Exception.Message}\n\nThe log is in {Engine.Log.FilePath}",
                "Termilly Setup", MessageBoxButton.OK, MessageBoxImage.Error);
            args.Handled = true;
            Shutdown(1);
        };
        MainWindow = new MainWindow();
        MainWindow.Show();
    }
}
