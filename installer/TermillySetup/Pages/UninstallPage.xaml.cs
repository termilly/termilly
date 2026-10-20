using System;
using System.IO;
using System.Windows;
using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class UninstallPage : UserControl
{
    internal UninstallPage()
    {
        InitializeComponent();
        Keep.Checked += (_, _) => KeepChanged?.Invoke(true);
        Keep.Unchecked += (_, _) => KeepChanged?.Invoke(false);
    }

    public bool KeepData => Keep.IsChecked == true;

    public event Action<bool>? KeepChanged;

    public void ShowProgress()
    {
        Ask.Visibility = Visibility.Collapsed;
        Working.Visibility = Visibility.Visible;
    }

    public void Report(string text, double fraction)
    {
        Now.Text = text;
        Bar.Value = fraction;
    }

    public void ShowDone(bool keptData)
    {
        Working.Visibility = Visibility.Collapsed;
        Finished.Visibility = Visibility.Visible;
        DoneText.Text = keptData
            ? "Your settings and history are kept."
            : "Your settings and history were removed too.";
    }
}
