using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;
using System.Windows.Threading;

namespace Termilly.Desktop;

/// <summary>
/// The start-up screen's moving parts (MainWindow.xaml's Loader): its mark at the display's scale, and "Loading"
/// typed a letter at a time, then its dots cycling ("Loading", "Loading." … "Loading..."), with the caret blinking
/// after it, as js/loader.js does on Linux. It runs even with Windows' animations off: still text would look stuck.
/// </summary>
internal sealed class StartupLoader(Image mark, TextBlock text, Rectangle caret)
{
    private const string Word = "Loading";
    private const int MaxDots = 3;
    /// <summary>The mark's size at 100%, and pre-rendered at each display scale from 100% to 200%.</summary>
    private const int MarkSize = 48;
    private static readonly int[] MarkSizes = [48, 60, 72, 84, 96];
    private static readonly TimeSpan LetterDelay = TimeSpan.FromMilliseconds(85);
    private static readonly TimeSpan WordPause = TimeSpan.FromMilliseconds(320);
    private static readonly TimeSpan BlinkCycle = TimeSpan.FromSeconds(1.1);
    private static readonly TimeSpan BlinkOff = TimeSpan.FromSeconds(0.55);

    private readonly DispatcherTimer _typing = new();
    private int _typed;
    private int _dots;

    /// <summary>
    /// Uses the mark pre-rendered at this display's pixel size, shown 1:1 so it stays sharp. Scales without an exact
    /// image fall back to the next size up, scaled down smoothly.
    /// </summary>
    public void ShowMark(double dpiScale)
    {
        var wanted = (int)Math.Round(MarkSize * dpiScale);
        var size = MarkSizes.FirstOrDefault(s => s >= wanted, MarkSizes[^1]);
        mark.Source = new BitmapImage(new Uri($"pack://application:,,,/Assets/loader/mark-{size}.png"));
        RenderOptions.SetBitmapScalingMode(mark, size == wanted ? BitmapScalingMode.NearestNeighbor : BitmapScalingMode.HighQuality);
    }

    public void Start()
    {
        _typing.Interval = LetterDelay;
        _typing.Tick += (_, _) => Type();
        _typing.Start();
        var blink = new DoubleAnimationUsingKeyFrames { Duration = BlinkCycle, RepeatBehavior = RepeatBehavior.Forever };
        blink.KeyFrames.Add(new DiscreteDoubleKeyFrame(1, TimeSpan.Zero));
        blink.KeyFrames.Add(new DiscreteDoubleKeyFrame(0, BlinkOff));
        caret.BeginAnimation(UIElement.OpacityProperty, blink);
    }

    public void Stop()
    {
        _typing.Stop();
        caret.BeginAnimation(UIElement.OpacityProperty, null);
    }

    private void Type()
    {
        if (_typed < Word.Length)
        {
            text.Text = Word[..++_typed];
            _typing.Interval = _typed == Word.Length ? WordPause : LetterDelay;
            return;
        }
        _dots = (_dots + 1) % (MaxDots + 1);
        text.Text = Word + new string('.', _dots);
    }
}
