using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// A terminal dragged by its title bar, as a see-through picture of itself at its own size that follows the pointer
/// anywhere on the screen, past the main window too (js/panes.js): let go outside the main window, its window opens
/// where the picture is. The pointer goes through it; it's never active. It follows the pointer every frame, held
/// where the pointer took the terminal.
/// </summary>
internal sealed class DragPictureWindow : Window
{
    /// <summary>How much of the picture shows: see-through enough for what's under it (a drop zone) to show.</summary>
    private const double PictureOpacity = 0.6;

    private readonly Point _grip;

    public DragPictureWindow(FromPage.DragPicture picture, string image)
    {
        _grip = new Point(picture.X, picture.Y);
        WindowStyle = WindowStyle.None;
        AllowsTransparency = true;
        Background = Brushes.Transparent;
        ResizeMode = ResizeMode.NoResize;
        ShowInTaskbar = false;
        ShowActivated = false;
        Topmost = true;
        IsHitTestVisible = false;
        Opacity = PictureOpacity;
        WindowStartupLocation = WindowStartupLocation.Manual;
        Width = picture.Width;
        Height = picture.Height;
        Content = new Image { Source = Decode(image), Stretch = Stretch.Fill };
        SourceInitialized += (_, _) => WindowInterop.ClickThrough(this);
        CompositionTarget.Rendering += Follow;
        Closed += (_, _) => CompositionTarget.Rendering -= Follow;
        Follow(null, EventArgs.Empty);
    }

    /// <summary>To where the pointer is now, held where it took the terminal.</summary>
    private void Follow(object? sender, EventArgs e)
    {
        var cursor = WindowInterop.CursorPosition();
        if (double.IsNaN(cursor.X))
        {
            return;
        }
        var dpi = VisualTreeHelper.GetDpi(this);
        Left = (cursor.X / dpi.DpiScaleX) - _grip.X;
        Top = (cursor.Y / dpi.DpiScaleY) - _grip.Y;
    }

    private static BitmapImage Decode(string base64)
    {
        var bitmap = new BitmapImage();
        bitmap.BeginInit();
        bitmap.CacheOption = BitmapCacheOption.OnLoad;
        bitmap.StreamSource = new MemoryStream(Convert.FromBase64String(base64));
        bitmap.EndInit();
        bitmap.Freeze();
        return bitmap;
    }
}
