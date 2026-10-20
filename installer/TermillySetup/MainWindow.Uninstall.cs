using System;
using System.Diagnostics;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Termilly.Setup.Engine;
using Termilly.Setup.Pages;

namespace Termilly.Setup;

// The setup window's maintenance (update or uninstall an installed Termilly) and uninstall pages.
public partial class MainWindow
{
    private static readonly string[] UninstallFlow = { "Choose", "Uninstall", "Done" };
    /// <summary>The uninstall's steps on the rail: choosing what to keep, then uninstalling.</summary>
    private const int ChooseStep = 1;
    private const int UninstallingStep = 2;
    private const string UninstallRailTitle = "UNINSTALL";

    private void ShowMaintenance()
    {
        var page = new MaintenancePage(_installed!, _payload);
        page.Update += () => ShowChecks(update: true);
        page.Uninstall += ShowUninstall;
        Show(page, null, 0);
        Footer(null, Ghost(CloseText, Close, isDefault: true));
    }

    private void ShowUninstall()
    {
        // Uninstalling from the install folder would leave setup unable to remove itself: run from a temp copy.
        if (_installed is not null && IsInside(SetupApp.ExePath, _installed.Dir))
        {
            var copy = Path.Combine(Log.Folder, InstalledFiles.Setup);
            Directory.CreateDirectory(Log.Folder);
            Payload.WriteProgramOf(SetupApp.ExePath, copy);
            Process.Start(new ProcessStartInfo(copy, $"{Flags.Uninstall} {Flags.TempCopy}") { UseShellExecute = false });
            Close();
            return;
        }
        if (_installed!.AllUsers && !Elevation.IsElevated)
        {
            if (Elevation.Restart(Flags.Uninstall + (SetupApp.Has(Flags.TempCopy) ? $" {Flags.TempCopy}" : "")) is { } child)
            {
                WaitFor(child);
            }
            else
            {
                ShowError(new SetupException("Uninstalling for all users needs administrator permission, and it was declined."), retry: ShowUninstall);
            }
            return;
        }
        TitleText.Text = "Uninstall Termilly";
        var page = new UninstallPage();
        Show(page, UninstallFlow, ChooseStep, UninstallRailTitle);
        var left = Fine("");
        page.KeepChanged += keep => left.Text = keep ? "" : "Your settings and history will be deleted too.";
        Footer(left, Ghost(CancelText, Close), Button("Uninstall", Styles.Danger, () => RunUninstall(page.KeepData)));
    }

    private void RunUninstall(bool keepData)
    {
        var page = new UninstallPage();
        Show(page, UninstallFlow, UninstallingStep, UninstallRailTitle);
        page.ShowProgress();
        Footer(null);
        _busy = true;
        _ = Task.Run(async () =>
        {
            try
            {
                await Uninstallation.UninstallAsync(_installed!, keepData, (text, f) => Dispatcher.BeginInvoke(new Action(() => page.Report(text, f))), CancellationToken.None).ConfigureAwait(false);
                Dispatcher.Invoke(() =>
                {
                    _busy = false;
                    page.ShowDone(keepData);
                    Footer(null, Primary(CloseText, Close));
                });
            }
            catch (Exception e)
            {
                Log.Write($"uninstall failed: {e}");
                Dispatcher.Invoke(() =>
                {
                    _busy = false;
                    ShowError(e as SetupException ?? new SetupException(e.Message), retry: () => RunUninstall(keepData),
                        lead: "Setup stopped; some of Termilly may still be on this PC. Retry to finish removing it.");
                });
            }
        });
    }
}
