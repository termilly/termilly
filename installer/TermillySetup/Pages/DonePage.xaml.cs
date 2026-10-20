using System.IO;
using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class DonePage : UserControl
{
    private readonly bool _tourWas;

    internal DonePage(SetupOptions options)
    {
        InitializeComponent();
        Where.Text = options.StartMenu ? "Find it in the Start menu." : options.InstallDir;
        Launch.IsChecked = options.Launch;
        Tour.IsChecked = _tourWas = options.Tour;
    }

    internal void Apply(SetupOptions options)
    {
        options.Launch = Launch.IsChecked == true;
        options.Tour = Tour.IsChecked == true;
        if (options.Tour != _tourWas)
        {
            // The tour offer lives in Termilly's settings, already written by the install: follow the box.
            try
            {
                TermillySettings.SetTourSeen(!options.Tour);
            }
            catch (System.Exception e) when (e is IOException or System.UnauthorizedAccessException)
            {
                Log.Write($"couldn't update the tour setting: {e.Message}");
            }
        }
    }
}
