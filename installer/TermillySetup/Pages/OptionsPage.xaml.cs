using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class OptionsPage : UserControl
{
    internal OptionsPage(SetupOptions options, Payload payload)
    {
        InitializeComponent();
        JustMe.IsChecked = !options.AllUsers;
        AllUsers.IsChecked = options.AllUsers;
        Dir.Text = options.InstallDir;
        StartMenu.IsChecked = options.StartMenu;
        Desktop.IsChecked = options.Desktop;
        Explorer.IsChecked = options.ExplorerMenu;
        PathCommand.IsChecked = options.PathCommand;
        Agent.IsChecked = options.AgentIntegration;
        SignIn.IsChecked = options.BackgroundAtSignIn;
        Download.IsChecked = !options.PreferIncluded;
        Included.IsChecked = options.PreferIncluded;

        void Scope(bool all)
        {
            // Following the scope only while the folder is still a default one.
            if (Dir.Text == SetupOptions.DefaultDir(!all))
            {
                Dir.Text = SetupOptions.DefaultDir(all);
            }
        }
        JustMe.Checked += (_, _) => Scope(false);
        AllUsers.Checked += (_, _) => Scope(true);
        Scope(options.AllUsers);

        Browse.Click += (_, _) =>
        {
            if (FolderPicker.Pick(Window.GetWindow(this), Dir.Text) is { } picked)
            {
                // A folder that isn't empty gets Termilly in its own subfolder, so uninstalling can't take anything else with it.
                Dir.Text = Directory.Exists(picked) && Directory.GetFileSystemEntries(picked).Length > 0 && !File.Exists(Path.Combine(picked, "Termilly.exe"))
                    ? Path.Combine(picked, "Termilly")
                    : picked;
            }
        };

        Space.Text = $"{Checks.AppMb(payload)} MB" + (Checks.FreeGb(options.InstallDir) is { } free ? $" · {free:0} GB free" : "");
    }

    /// <summary>Copies the choices into <paramref name="options"/>.</summary>
    internal void Apply(SetupOptions options)
    {
        options.AllUsers = AllUsers.IsChecked == true;
        options.InstallDir = string.IsNullOrWhiteSpace(Dir.Text) ? SetupOptions.DefaultDir(options.AllUsers) : Environment.ExpandEnvironmentVariables(Dir.Text.Trim());
        options.StartMenu = StartMenu.IsChecked == true;
        options.Desktop = Desktop.IsChecked == true;
        options.ExplorerMenu = Explorer.IsChecked == true;
        options.PathCommand = PathCommand.IsChecked == true;
        options.AgentIntegration = Agent.IsChecked == true;
        options.BackgroundAtSignIn = SignIn.IsChecked == true;
        options.PreferIncluded = Included.IsChecked == true;
    }
}
