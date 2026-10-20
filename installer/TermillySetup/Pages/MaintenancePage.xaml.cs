using System;
using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class MaintenancePage : UserControl
{
    internal MaintenancePage(InstalledTermilly installed, Payload? payload)
    {
        InitializeComponent();
        Heading.Text = $"Termilly {installed.Version} is installed";
        Sub.Text = installed.Dir;

        if (payload is null)
        {
            // The copy of setup in the install folder carries no Termilly to install.
            UpdateCard.IsEnabled = false;
            UpdateTitle.Text = "Update or repair";
            UpdateText.Text = "Needs the full setup from termilly.com.";
        }
        else
        {
            var newer = InstalledTermilly.CompareVersions(payload.Version, installed.Version);
            if (newer == 0)
            {
                UpdateIcon.Data = System.Windows.Media.Geometry.Parse("M10.5,2.5 A3,3 0 0 0 7.7,6.5 L3,11.2 L4.8,13 L9.5,8.3 A3,3 0 0 0 13.5,5.5 L11.7,7.3 L10,7 L9.7,5.3 Z"); // a wrench
            }
            UpdateTitle.Text = newer > 0 ? $"Update to {payload.Version}" : newer == 0 ? "Repair" : $"Go back to {payload.Version}";
            UpdateText.Text = newer == 0 ? "Restores files and shortcuts." : "Keeps your settings and workspaces.";
        }
        UpdateCard.Click += (_, _) => Update?.Invoke();
        UninstallCard.Click += (_, _) => Uninstall?.Invoke();
    }

    public event Action? Update;

    public event Action? Uninstall;
}
