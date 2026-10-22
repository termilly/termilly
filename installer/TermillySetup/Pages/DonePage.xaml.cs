using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class DonePage : UserControl
{
    internal DonePage(SetupOptions options)
    {
        InitializeComponent();
        Where.Text = options.StartMenu ? "Find it in the Start menu." : options.InstallDir;
        Launch.IsChecked = options.Launch;
    }

    internal void Apply(SetupOptions options) => options.Launch = Launch.IsChecked == true;
}
