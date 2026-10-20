using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Interop;
using System.Windows.Media;
using Termilly.Setup.Engine;
using Termilly.Setup.Pages;

namespace Termilly.Setup;

// The setup window's parts: the step rail, the button bar, the error page and the window itself.
public partial class MainWindow
{
    /// <summary>The button bar's words that come back on several pages.</summary>
    private const string NextText = "Next";
    private const string BackText = "Back";
    private const string CancelText = "Cancel";
    private const string CloseText = "Close";
    private const string SetupRailTitle = "SETUP";

    /// <summary>Theme/*.xaml's styles and brushes the window uses by name.</summary>
    private static class Styles
    {
        public const string Primary = "Primary";
        public const string Ghost = "Ghost";
        public const string Danger = "DangerButton";
        public const string Link = "Link";
        public const string Fine = "Fine";
    }

    /// <summary>The rail's width, and the size of a step's numbered dot and its number.</summary>
    private const double RailWidth = 188;
    private const double DotSize = 18;
    private const double DotNumberSize = 10;
    private const double StepGap = 10;
    /// <summary>A step's row: its padding, rounded corners and the gap below it.</summary>
    private static readonly Thickness StepPadding = new(8, 7, 8, 7);
    private const double StepRadius = 7;
    private static readonly Thickness StepMargin = new(0, 0, 0, 2);

    /// <summary>A step on the rail: done (a tick), the current one (in the accent) or still to come.</summary>
    private enum StepState
    {
        Done,
        Current,
        ToCome,
    }

    // ---- Error ----

    private void ShowError(SetupException error, Action? retry, string lead = "Setup can't continue.")
    {
        var page = new ErrorPage(error, lead);
        Show(page, Steps.Children.Count > 0 ? InstallFlow : null, (int)InstallStage.Install);
        var buttons = new List<Button> { Ghost(CloseText, Close) };
        if (retry is not null)
        {
            buttons.Add(Primary("Retry", retry));
        }
        var links = new StackPanel { Orientation = Orientation.Horizontal };
        links.Children.Add(LinkButton("Copy details", () => Clipboard.SetText($"{error.Message}\n{error.Detail}\n\n{Log.All}")));
        links.Children.Add(new TextBlock { Text = " · ", Foreground = (Brush)FindResource(ThemeBrushes.Faint) });
        links.Children.Add(LinkButton("Open log", () => Process.Start(new ProcessStartInfo("notepad.exe", Elevation.Quote(Log.FilePath)))));
        Footer(links, buttons.ToArray());
    }

    // ---- Window parts ----

    private void Show(FrameworkElement page, string[]? flow, int step, string railTitle = SetupRailTitle)
    {
        Page.Content = page;
        RailColumn.Width = flow is null ? new GridLength(0) : new GridLength(RailWidth);
        Rail.Visibility = flow is null ? Visibility.Collapsed : Visibility.Visible;
        RailTitle.Text = railTitle;
        Steps.Children.Clear();
        if (flow is null)
        {
            return;
        }
        for (var i = 0; i < flow.Length; i++)
        {
            Steps.Children.Add(StepItem(i + 1, flow[i], i < step ? StepState.Done : i == step ? StepState.Current : StepState.ToCome));
        }
    }

    /// <summary>One step on the rail: its numbered dot (a tick once done) and its name.</summary>
    private static Border StepItem(int number, string name, StepState state)
    {
        var dot = new Border { Width = DotSize, Height = DotSize, CornerRadius = new CornerRadius(DotSize / 2), BorderThickness = new Thickness(1) };
        var dotText = new TextBlock
        {
            Text = state == StepState.Done ? "✓" : number.ToString(System.Globalization.CultureInfo.InvariantCulture),
            FontSize = DotNumberSize, FontWeight = FontWeights.SemiBold, HorizontalAlignment = HorizontalAlignment.Center,
            VerticalAlignment = VerticalAlignment.Center,
        };
        dot.Child = dotText;
        var label = new TextBlock { Text = name, Margin = new Thickness(StepGap, 0, 0, 0), VerticalAlignment = VerticalAlignment.Center };
        var row = new StackPanel { Orientation = Orientation.Horizontal };
        row.Children.Add(dot);
        row.Children.Add(label);
        var item = new Border { Padding = StepPadding, CornerRadius = new CornerRadius(StepRadius), Margin = StepMargin, Child = row };
        Colour(state, item, dot, dotText, label);
        return item;
    }

    /// <summary>A step's colours for its state.</summary>
    private static void Colour(StepState state, Border item, Border dot, TextBlock dotText, TextBlock label)
    {
        switch (state)
        {
            case StepState.Done:
                dot.SetResourceReference(Border.BackgroundProperty, ThemeBrushes.AccentFill);
                dot.BorderBrush = System.Windows.Media.Brushes.Transparent;
                dotText.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Accent);
                label.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Text);
                break;
            case StepState.Current:
                item.SetResourceReference(Border.BackgroundProperty, ThemeBrushes.AccentFill);
                dot.SetResourceReference(Border.BackgroundProperty, ThemeBrushes.Accent);
                dot.SetResourceReference(Border.BorderBrushProperty, ThemeBrushes.Accent);
                dotText.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.OnAccent);
                label.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.TextStrong);
                label.FontWeight = FontWeights.SemiBold;
                break;
            default:
                dot.SetResourceReference(Border.BorderBrushProperty, ThemeBrushes.BorderStrong);
                dotText.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Muted);
                label.SetResourceReference(TextBlock.ForegroundProperty, ThemeBrushes.Muted);
                break;
        }
    }

    private void Footer(UIElement? left, params Button[] buttons)
    {
        FooterLeft.Content = left;
        FooterButtons.Children.Clear();
        foreach (var b in buttons)
        {
            FooterButtons.Children.Add(b);
        }
        CloseButton.IsEnabled = !_busy;
    }

    /// <summary>The page's main button (Enter presses it).</summary>
    private Button Primary(string text, Action click) => Button(text, Styles.Primary, click, isDefault: true);

    private Button Ghost(string text, Action click, bool isDefault = false) => Button(text, Styles.Ghost, click, isDefault);

    private Button Button(string text, string style, Action click, bool isDefault = false)
    {
        var b = new Button { Content = text, Style = (Style)FindResource(style), IsDefault = isDefault };
        b.Click += (_, _) => click();
        return b;
    }

    private Button LinkButton(string text, Action click)
    {
        var b = new Button { Content = text, Style = (Style)FindResource(Styles.Link) };
        b.Click += (_, _) =>
        {
            try
            {
                click();
            }
            catch (Exception e) when (e is System.ComponentModel.Win32Exception or COMException or ExternalException)
            {
                Log.Write($"{text}: {e.Message}");
            }
        };
        return b;
    }

    private TextBlock Fine(string text) => new() { Text = text, Style = (Style)FindResource(Styles.Fine), VerticalAlignment = VerticalAlignment.Center };

    private static bool IsInside(string file, string dir) =>
        Path.GetFullPath(file).StartsWith(Path.GetFullPath(dir).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);

    private void OnMinimize(object sender, RoutedEventArgs e) => WindowState = WindowState.Minimized;

    private void OnClose(object sender, RoutedEventArgs e) => Close();

    protected override void OnClosing(System.ComponentModel.CancelEventArgs e)
    {
        if (_busy)
        {
            e.Cancel = true; // not halfway through: the Installing page's Cancel stops safely
            return;
        }
        base.OnClosing(e);
    }

    protected override void OnClosed(EventArgs e)
    {
        base.OnClosed(e);
        _work?.Dispose();
        // The temp copy used for uninstalling removes itself once it has exited.
        if (SetupApp.Has(Flags.TempCopy))
        {
            Process.Start(new ProcessStartInfo("cmd.exe", $"/c ping -n 3 127.0.0.1 >nul & rmdir /s /q {Elevation.Quote(Path.GetDirectoryName(SetupApp.ExePath)!)}")
            {
                UseShellExecute = false,
                CreateNoWindow = true,
            });
        }
    }

    /// <summary>Windows 11 rounds the corners of a window that asks; Windows 10 ignores it.</summary>
    private void RoundCorners()
    {
        var hwnd = new WindowInteropHelper(this).Handle;
        var preference = DwmwcpRound;
        _ = DwmSetWindowAttribute(hwnd, DwmwaWindowCornerPreference, ref preference, sizeof(int)); // Windows 10 doesn't round: fine
    }

    /// <summary>DWMWA_WINDOW_CORNER_PREFERENCE, and its DWMWCP_ROUND value (Windows 11).</summary>
    private const int DwmwaWindowCornerPreference = 33;
    private const int DwmwcpRound = 2;

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
}
