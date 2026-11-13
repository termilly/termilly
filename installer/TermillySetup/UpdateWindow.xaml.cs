using System;
using System.ComponentModel;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using Termilly.Setup.Engine;
using Termilly.Shared;

namespace Termilly.Setup;

/// <summary>Only in-app updates show this window. Installation runs off its dispatcher so it keeps painting.</summary>
public partial class UpdateWindow : Window
{
    private static readonly TimeSpan StartupWait = TimeSpan.FromSeconds(30);
    /// <summary>The most of a failure's reason the window shows; a longer one is cut, with "..." after it.</summary>
    private const int ReasonMax = 240;
    private const string Cut = "...";
    private bool _finished;
    private int _exitCode = ExitCodes.Failed;

    internal static bool IsRequested(Arguments args) =>
        args.Has(SetupFlags.Quiet) && args.Has(SetupFlags.Start) && args.Has(SetupFlags.UpdateWindow) && !args.Has(Flags.Uninstall);

    public UpdateWindow()
    {
        InitializeComponent();
        Closing += (_, e) => e.Cancel = !_finished;
        Closed += (_, _) => Application.Current.Shutdown(_exitCode);
        ContentRendered += RunUpdate;
    }

    /// <summary>
    /// Tells the app this window is up (its Shown event) and returns the event the new version's start-up screen sets
    /// (Started), or null when the events can't be had: the window then waits the whole StartupWait.
    /// </summary>
    private static EventWaitHandle? SignalShown()
    {
        // The app passes its scope so UAC with another administrator's credentials uses the same events.
        var scope = SetupApp.Args.Value(SetupFlags.UpdateWindow);
        if (!UpdateSignals.IsScope(scope))
        {
            var dir = SetupApp.Args.Value(Flags.Dir) ?? InstalledTermilly.Find()?.Dir ?? SetupOptions.DefaultDir(SetupApp.Has(Flags.AllUsers));
            scope = UpdateSignals.Scope(Path.GetFullPath(Environment.ExpandEnvironmentVariables(dir)));
        }
        try
        {
            var started = UpdateSignals.Create(scope!, UpdateSignals.Started);
            started.Reset();
            using var shown = UpdateSignals.Create(scope!, UpdateSignals.Shown);
            shown.Set();
            Log.Write("update window painted");
            return started;
        }
        catch (Exception error) when (error is Win32Exception or UnauthorizedAccessException or IOException)
        {
            Log.Write($"update paint signals unavailable: {error.Message}");
            return null;
        }
    }

    private async void RunUpdate(object? sender, EventArgs e)
    {
        ContentRendered -= RunUpdate;
        EventWaitHandle? started = null;
        try
        {
            started = SignalShown();
            var version = Payload.Open(SetupApp.ExePath)?.Version;
            Status.Text = version is null ? "Updating Termilly" : "Updating Termilly to " + version;
            string? failure = null;
            var result = await Task.Run(() => Quiet.Run(
                () => Dispatcher.BeginInvoke(new Action(() => Status.Text = "Starting Termilly")),
                reason => failure = reason));
            _exitCode = result;
            if (result != ExitCodes.Done)
            {
                ShowFailure(failure ?? (result == WindowsCodes.ElevationRequired
                    ? "Administrator permission is required to update this installation."
                    : "The update could not be completed. See the setup log for details."));
                return;
            }

            Status.Text = "Starting Termilly";
            Log.Write("waiting up to 30000 ms for Termilly's startup screen to paint");
            var painted = started is not null
                ? await Task.Run(() => started.WaitOne(StartupWait))
                : await Task.Run(() => { Thread.Sleep(StartupWait); return false; });
            Log.Write(painted ? "Termilly startup screen painted" : "startup screen paint wait timed out");
            _finished = true;
            Close();
        }
        catch (Exception error)
        {
            Log.Write($"update window failed: {error}");
            ShowFailure(error.Message);
        }
        finally { started?.Dispose(); }
    }

    private void ShowFailure(string reason)
    {
        _exitCode = ExitCodes.Failed;
        Status.Text = "Termilly could not be updated";
        var shortReason = reason.Replace('\r', ' ').Replace('\n', ' ');
        Reason.Text = shortReason.Length > ReasonMax ? shortReason.Substring(0, ReasonMax - Cut.Length) + Cut : shortReason;
        Reason.Visibility = LogLabel.Visibility = LogPath.Visibility = CloseButton.Visibility = Visibility.Visible;
        LogPath.Text = Log.FilePath;
        Busy.Visibility = Visibility.Collapsed;
        _finished = true;
    }

    private void OnClose(object sender, RoutedEventArgs e) => Close();
}
