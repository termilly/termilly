using System.Globalization;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Termilly.Desktop;

/// <summary>
/// The taskbar button's overlay: an amber disc with how many terminals need the user. Drawn at 32 px, twice the
/// overlay's size, so it stays sharp at 200%.
/// </summary>
internal static class TaskbarBadge
{
    private const int Size = 32;
    private const double Center = Size / 2.0;
    private const double Radius = Center - 1;
    private const double OutlineWidth = 2;
    private const double Dpi = 96;
    /// <summary>Drawn at twice the overlay's size.</summary>
    private const double PixelsPerDip = 2.0;
    /// <summary>Past this, the badge says "9+".</summary>
    private const int MaxShown = 9;
    private const double DigitSize = 19;
    private const double PlusSize = 15;
    private const string Amber = "#F2CC60";
    private const string Ink = "#0B0B0B";
    private const string Font = "Segoe UI";

    public static BitmapSource Render(int count)
    {
        var ink = Brush(Ink);
        var visual = new DrawingVisual();
        using (var dc = visual.RenderOpen())
        {
            dc.DrawEllipse(Brush(Amber), new Pen(ink, OutlineWidth), new Point(Center, Center), Radius, Radius);
            var many = count > MaxShown;
            var text = new FormattedText(
                many ? $"{MaxShown}+" : count.ToString(CultureInfo.InvariantCulture), CultureInfo.InvariantCulture, FlowDirection.LeftToRight,
                new Typeface(new FontFamily(Font), FontStyles.Normal, FontWeights.Bold, FontStretches.Normal),
                many ? PlusSize : DigitSize, ink, PixelsPerDip);
            dc.DrawText(text, new Point(Center - text.Width / 2, Center - text.Height / 2));
        }
        var bitmap = new RenderTargetBitmap(Size, Size, Dpi, Dpi, PixelFormats.Pbgra32);
        bitmap.Render(visual);
        bitmap.Freeze();
        return bitmap;
    }

    private static SolidColorBrush Brush(string hex) => (SolidColorBrush)new BrushConverter().ConvertFromString(hex)!;
}
