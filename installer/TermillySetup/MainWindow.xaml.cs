using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using Termilly.Setup.Engine;
using Termilly.Setup.Pages;

namespace Termilly.Setup;

/// <summary>
/// The setup window: Termilly's title bar, the step rail, the page and the button bar. It walks the user through
/// install (Welcome, License, Options, Checks, Installing, Done), maintenance and uninstall (MainWindow.Uninstall.cs).
/// The window's own parts are in MainWindow.Parts.cs.
/// </summary>
[System.Diagnostics.CodeAnalysis.SuppressMessage("Reliability", "CA1001", Justification = "WPF never disposes a window: OnClosed disposes what it owns.")]
public partial class MainWindow : Window
{
    /// <summary>The install's steps on the rail, in order.</summary>
    private enum InstallStage
    {
        Welcome,
        License,
        Options,
        Checks,
        Install,
        Done,
    }

    private static readonly string[] InstallFlow = { "Welcome", "License", "Options", "Checks", "Install", "Done" };

    private readonly Payload? _payload = Payload.Open(SetupApp.ExePath);
    private readonly InstalledTermilly? _installed = InstalledTermilly.Find();
    private SetupOptions _options = new();
    private CancellationTokenSource? _work;
    private bool _busy;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += (_, _) => RoundCorners();
        VersionText.Text = $"Termilly {_payload?.Version ?? _installed?.Version ?? ""} · x64";
        Log.Write($"Setup {(_payload is null ? "(installed copy, no payload)" : _payload.Version)} from {SetupApp.ExePath}");
        Log.Write($"{Detect.Windows().Text} · {(Elevation.IsElevated ? "administrator" : "standard user")}");
        if (_installed is not null)
        {
            _options = _installed.Options;
            Log.Write($"installed: {_installed.Version} in {_installed.Dir} ({(_installed.AllUsers ? "all users" : "this user")})");
        }
        Loaded += (_, _) => Start();
    }

    /// <summary>What setup was started for: an elevated install or uninstall, uninstall from Apps &amp; features, or the wizard.</summary>
    private void Start()
    {
        if (SetupApp.Value(Flags.ElevatedInstall) is { } options && _payload is not null)
        {
            _options = SetupOptions.FromArgument(options);
            ShowInstalling();
        }
        else if (SetupApp.Has(Flags.Uninstall))
        {
            if (_installed is null)
            {
                ShowError(new SetupException("Termilly isn't installed.", "There's nothing to uninstall."), retry: null);
            }
            else
            {
                ShowUninstall();
            }
        }
        else if (_installed is not null)
        {
            ShowMaintenance();
        }
        else if (_payload is null)
        {
            // The bare program from the build folder, or the copy kept with an uninstalled Termilly.
            ShowError(new SetupException("This copy of setup has nothing to install: Termilly isn't packed into it.",
                @"Run the full setup, TermillySetup-<version>.exe (installer\build.ps1 puts it in dist\), or download it from termilly.com."), retry: null);
        }
        else
        {
            ShowWelcome();
        }
    }

    // ---- Install pages ----

    private void ShowInstallPage(FrameworkElement page, InstallStage stage) => Show(page, InstallFlow, (int)stage);

    private void ShowWelcome()
    {
        ShowInstallPage(new WelcomePage(_payload!.Version), InstallStage.Welcome);
        Footer(Fine("© Termilly · termilly.com"), Ghost(CancelText, Close), Primary(NextText, ShowLicense));
    }

    private void ShowLicense()
    {
        var page = new LicensePage();
        ShowInstallPage(page, InstallStage.License);
        var next = Primary(NextText, ShowOptions);
        next.IsEnabled = page.Accepted;
        page.AcceptedChanged += () => next.IsEnabled = page.Accepted;
        Footer(null, Ghost(BackText, ShowWelcome), next);
    }

    private void ShowOptions()
    {
        var page = new OptionsPage(_options, _payload!);
        ShowInstallPage(page, InstallStage.Options);
        Footer(null, Ghost(BackText, () => { page.Apply(_options); ShowLicense(); }),
            Primary(NextText, () => { page.Apply(_options); ShowChecks(); }));
    }

    private void ShowChecks(bool update = false)
    {
        var page = new ChecksPage(_options, _payload!, update ? _installed : null);
        ShowInstallPage(page, InstallStage.Checks);
        var install = Primary(update ? "Update" : "Install", Install);
        Footer(null, Ghost(BackText, update ? ShowMaintenance : ShowOptions), install);
        page.CanInstallChanged += ok => install.IsEnabled = ok;
        install.IsEnabled = page.CanInstall;
    }

    /// <summary>For all users, setup restarts as administrator and carries on there; this window waits for it.</summary>
    private void Install()
    {
        if (_options.AllUsers && !Elevation.IsElevated)
        {
            var child = Elevation.Restart($"{Flags.ElevatedInstall} {Elevation.Quote(_options.ToArgument())}");
            if (child is null)
            {
                ShowError(new SetupException("Installing for all users needs administrator permission, and it was declined.",
                    "Retry and choose Yes, or go back and install for just you."), retry: () => ShowChecks());
                return;
            }
            WaitFor(child);
            return;
        }
        ShowInstalling();
    }

    private void ShowInstalling()
    {
        var page = new InstallingPage();
        ShowInstallPage(page, InstallStage.Install);
        var next = Primary(NextText, () => { });
        next.IsEnabled = false;
        Footer(null, Ghost(CancelText, () => _work?.Cancel()), next);

        var installation = new Installation(_payload!, _options);
        _work?.Dispose();
        _work = new CancellationTokenSource();
        _busy = true;
        var stopwatch = Stopwatch.StartNew();
        var token = _work.Token;
        _ = Task.Run(async () =>
        {
            try
            {
                await installation.InstallAsync(p => Dispatcher.BeginInvoke(new Action(() => page.Report(p))), token).ConfigureAwait(false);
                Dispatcher.Invoke(() =>
                {
                    _busy = false;
                    ShowDone(stopwatch.Elapsed, installation.UsedIncludedRuntime);
                });
            }
            catch (Exception e)
            {
                Log.Write($"install failed: {e}");
                Dispatcher.Invoke(() =>
                {
                    _busy = false;
                    if (e is OperationCanceledException)
                    {
                        ShowError(new SetupException("Setup was cancelled.", "Nothing was changed after the step that was running; run setup again to install."), retry: ShowInstalling);
                    }
                    else
                    {
                        ShowError(e as SetupException ?? new SetupException(e.Message), retry: ShowInstalling,
                            lead: "Setup stopped and put back what it had changed in Termilly's folder.");
                    }
                });
            }
        });
    }

    private void ShowDone(TimeSpan took, bool includedRuntime)
    {
        var page = new DonePage(_options);
        ShowInstallPage(page, InstallStage.Done);
        Log.Write($"finished in {took.TotalSeconds:0} s{(includedRuntime ? ", .NET from setup's own copy" : "")}");
        Footer(null, Primary("Finish", () => Finish(page)));
    }

    private void Finish(DonePage page)
    {
        page.Apply(_options);
        if (_options.Launch)
        {
            var exe = Path.Combine(_options.InstallDir, InstalledFiles.App);
            try
            {
                // Through Explorer, so Termilly runs as the user even when setup is elevated.
                Process.Start(new ProcessStartInfo("explorer.exe", Elevation.Quote(exe)) { UseShellExecute = false });
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
            {
                Log.Write($"couldn't start Termilly: {e.Message}");
            }
        }
        Close();
    }

    /// <summary>Hides this window while setup runs again as administrator, and closes it when that one ends.</summary>
    private void WaitFor(Process child)
    {
        Hide();
        child.EnableRaisingEvents = true;
        child.Exited += (_, _) => Dispatcher.Invoke(Close);
    }
}
