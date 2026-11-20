using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Animation;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// The loader an update at start shows its steps on (StartupUpdateGate), before the main window exists: in the place
/// the main window opens, in the theme's colours, so the main window then takes its place without a jump.
/// </summary>
internal sealed partial class UpdateGateWindow : Window, IStartupUpdateView
{
    /// <summary>The main window's smallest size (MainWindow.xaml), so this one lands exactly where it will.</summary>
    private static readonly Size MainMinimum = new(702, 402);
    /// <summary>A busy bar's moving part, as a share of the bar, and how long it takes to cross.</summary>
    private const double BusyShare = 0.3;
    private static readonly Duration BusyCrossing = new(TimeSpan.FromSeconds(1.2));
    private const double AllOfIt = 100;

    private readonly StartupLoader _loader;
    private readonly TranslateTransform _busyMove = new();
    private bool _busy;
    private bool _finished;

    public event Action? NotNow;

    public UpdateGateWindow(ISettingsStore settings)
    {
        InitializeComponent();
        WindowInterop.UseCustomChrome(this);
        SourceInitialized += (_, _) => WindowPlacement.Restore(this, WindowPlacement.Plan(MainMinimum));
        Colour(new WindowTheme(settings, new SystemTheme()).Palette);
        _loader = StartupLoader.StartIn(this, Loader, LoaderMark, LoaderText, LoaderCaret);
        BarFill.RenderTransform = _busyMove;
        NotNowButton.Click += (_, _) =>
        {
            NotNowButton.IsEnabled = false;
            NotNow?.Invoke();
        };
        // Closing it (Alt+F4) while the update runs means "Not now": Termilly still starts, without the update.
        Closing += (_, e) =>
        {
            if (!_finished)
            {
                e.Cancel = true;
                NotNow?.Invoke();
            }
        };
        Closed += (_, _) => _loader.Stop();
    }


    /// <summary>Closes it once the update is done with, the main window in its place or Termilly quitting for setup.</summary>
    public void Finish()
    {
        _finished = true;
        Close();
    }

    public void Show(UpdateGateStep step) => Dispatcher.InvokeAsync(() =>
    {
        LoaderSize.Text = step.Line + StartupLoader.AllDots;
        _loader.Say(step.Line);
        Note.Text = step.Note ?? "";
        NotNowButton.Visibility = step.CanPutOff ? Visibility.Visible : Visibility.Hidden;
        ShowBar(step);
    });

    /// <summary>The bar: filled to the download's percent, moving while busy, hidden otherwise.</summary>
    private void ShowBar(UpdateGateStep step)
    {
        Bar.Visibility = step.Percent is not null || step.Busy ? Visibility.Visible : Visibility.Hidden;
        BarFill.Width = Bar.Width * (step.Busy ? BusyShare : Math.Clamp(step.Percent ?? 0, 0, AllOfIt) / AllOfIt);
        if (step.Busy == _busy)
        {
            return;
        }
        _busy = step.Busy;
        _busyMove.BeginAnimation(TranslateTransform.XProperty, step.Busy
            ? new DoubleAnimation(-BarFill.Width, Bar.Width, BusyCrossing) { RepeatBehavior = RepeatBehavior.Forever }
            : null);
        _busyMove.X = 0;
    }

    /// <summary>The theme's colours, as the main window's loader has them (MainWindow.ApplyTheme).</summary>
    private void Colour(ThemeWindowColors colors)
    {
        var background = Brush(colors.Background);
        var text = Brush(colors.Text);
        var frame = Brush(colors.Frame);
        Background = background;
        Loader.Background = background;
        LoaderText.Foreground = text;
        Note.Foreground = text;
        LoaderCaret.Fill = Brush(colors.Accent);
        BarFill.Background = Brush(colors.Accent);
        BarTrack.Background = frame;
        NotNowButton.Foreground = text;
        NotNowButton.Tag = frame;
    }

    private static SolidColorBrush Brush(string hex) => (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;

    /// <summary>Windows' light or dark mode, read without the main window's platform services.</summary>
    private sealed class SystemTheme : ISystemTheme
    {
        public bool PrefersLight => WindowsPlatform.SystemPrefersLight;
    }
}
