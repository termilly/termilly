using System.Windows;
using System.Windows.Controls;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class ErrorPage : UserControl
{
    internal ErrorPage(SetupException error, string lead)
    {
        InitializeComponent();
        Lead.Text = lead;
        Message.Text = error.Message;
        Detail.Text = error.Detail ?? "";
        Detail.Visibility = string.IsNullOrEmpty(error.Detail) ? Visibility.Collapsed : Visibility.Visible;
        LogText.Text = Log.All;
        LogText.ScrollToEnd();
    }
}
