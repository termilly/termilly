using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Shapes;
using Termilly.Setup.Engine;

namespace Termilly.Setup.Pages;

public partial class ChecksPage : UserControl
{
    private readonly SetupOptions _options;
    private readonly Payload _payload;

    internal ChecksPage(SetupOptions options, Payload payload, InstalledTermilly? updating)
    {
        InitializeComponent();
        _options = options;
        _payload = payload;
        if (updating is not null)
        {
            Heading.Text = InstalledTermilly.CompareVersions(payload.Version, updating.Version) > 0
                ? $"Ready to update to {payload.Version}"
                : $"Ready to reinstall {payload.Version}";
        }
        Refresh();
    }

    /// <summary>False when something rules installing out (old Windows, no disk space).</summary>
    public bool CanInstall { get; private set; }

    public event Action<bool>? CanInstallChanged;

    private void Refresh()
    {
        var items = Checks.Run(_options, _payload);
        foreach (var item in items)
        {
            Log.Write($"check: {item.Title}: {item.Tag} {item.Detail}");
        }
        Items.Children.Clear();
        for (var i = 0; i < items.Count; i++)
        {
            Items.Children.Add(Row(items[i], first: i == 0));
        }
        CanInstall = items.All(i => i.State != CheckState.Blocked);
        CanInstallChanged?.Invoke(CanInstall);
    }

    /// <summary>A state's colour, the fill behind its icon and tag, and its icon (a 12×12 path).</summary>
    private static (string Color, string Fill, string Glyph) Look(CheckState state) => state switch
    {
        CheckState.Ok => (ThemeBrushes.Ok, ThemeBrushes.OkFill, Glyphs.Tick),
        CheckState.WillInstall => (ThemeBrushes.Accent, ThemeBrushes.AccentFill, "M6,2 V8.5 M3.5,6.3 L6,8.8 L8.5,6.3 M2.5,10 H9.5"),
        CheckState.Warning => (ThemeBrushes.Attention, ThemeBrushes.AttentionFill, "M6,2.5 V6.5 M6,9 V9.01"),
        _ => (ThemeBrushes.DangerText, ThemeBrushes.DangerFill, "M3.5,3.5 L8.5,8.5 M8.5,3.5 L3.5,8.5"),
    };

    /// <summary>The icon's circle and the mark in it.</summary>
    private const double IconSize = 22;
    private const double GlyphSize = 12;
    private const double GlyphStroke = 1.8;
    /// <summary>The "Close it now" button's height and the tag's text size.</summary>
    private const double ButtonHeight = 26;
    private const double TagTextSize = 11;
    private const double TagRadius = 10;
    private static readonly Thickness TextMargin = new(12, 0, 12, 0);
    private static readonly Thickness ButtonPadding = new(10, 0, 10, 0);
    private static readonly Thickness TagPadding = new(8, 2, 8, 2);
    private static readonly Thickness RowMargin = new(14, 11, 14, 11);

    private Border Row(CheckItem item, bool first)
    {
        var (color, fill, glyph) = Look(item.State);
        var icon = Icon(color, fill, glyph);
        FrameworkElement right = item.CanCloseTermilly ? CloseButton() : StateTag(item.Tag, color, fill);
        var row = new DockPanel { Margin = RowMargin };
        DockPanel.SetDock(icon, Dock.Left);
        DockPanel.SetDock(right, Dock.Right);
        row.Children.Add(icon);
        row.Children.Add(right);
        row.Children.Add(Text(item));
        var border = new Border { Child = row, BorderThickness = new Thickness(0, first ? 0 : 1, 0, 0) };
        border.SetResourceReference(Border.BorderBrushProperty, ThemeBrushes.Border);
        return border;
    }

    private static Grid Icon(string color, string fill, string glyph)
    {
        var icon = new Grid { Width = IconSize, Height = IconSize, VerticalAlignment = VerticalAlignment.Center };
        var circle = new Ellipse();
        circle.SetResourceReference(Shape.FillProperty, fill);
        var mark = new Path
        {
            Data = Geometry.Parse(glyph), StrokeThickness = GlyphStroke, Width = GlyphSize, Height = GlyphSize,
            StrokeStartLineCap = PenLineCap.Round, StrokeEndLineCap = PenLineCap.Round, StrokeLineJoin = PenLineJoin.Round,
        };
        mark.SetResourceReference(Shape.StrokeProperty, color);
        icon.Children.Add(circle);
        icon.Children.Add(mark);
        return icon;
    }

    private StackPanel Text(CheckItem item)
    {
        var text = new StackPanel { Margin = TextMargin, VerticalAlignment = VerticalAlignment.Center };
        text.Children.Add(new TextBlock { Text = item.Title, Style = (Style)FindResource("Name") });
        if (item.Detail.Length > 0)
        {
            text.Children.Add(new TextBlock { Text = item.Detail, Style = (Style)FindResource("Desc") });
        }
        return text;
    }

    /// <summary>Closes the Termilly running from the install folder, then checks again.</summary>
    private Button CloseButton()
    {
        var close = new Button { Content = "Close it now", Style = (Style)FindResource("Btn"), Height = ButtonHeight, Padding = ButtonPadding, Margin = new Thickness(0) };
        close.Click += async (_, _) =>
        {
            close.IsEnabled = false;
            await Task.Run(() => Processes.CloseAll(_options.InstallDir));
            Refresh();
        };
        return close;
    }

    private static Border StateTag(string text, string color, string fill)
    {
        var tag = new Border { CornerRadius = new CornerRadius(TagRadius), Padding = TagPadding, VerticalAlignment = VerticalAlignment.Center };
        tag.SetResourceReference(Border.BackgroundProperty, fill);
        var label = new TextBlock { Text = text, FontSize = TagTextSize, FontWeight = FontWeights.SemiBold };
        label.SetResourceReference(TextBlock.ForegroundProperty, color);
        tag.Child = label;
        return tag;
    }
}
