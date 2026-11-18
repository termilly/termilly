using System.Drawing;
using Photino.NET;

namespace Termilly.Linux;

/// <summary>
/// Where the main window was on Linux and whether it was maximized, kept in window.json (<see cref="SavedPlacement"/>)
/// and put back the next time Termilly opens, as on Windows and macOS. In the desktop's pixels (X11: Termilly's windows
/// are X11 ones, see GtkWindow.UseX11). A place whose title bar is on no monitor now is left out.
/// </summary>
internal sealed class LinuxPlacement
{
    /// <summary>
    /// How long the window keeps still before its place counts as its normal one: maximizing moves and resizes it too,
    /// and the desktop may say so before it says it's maximized.
    /// </summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(400);
    /// <summary>How far down from a window's top its title bar is looked for on the monitors, in pixels.</summary>
    private const int TitleBarDepth = 20;

    private readonly SavedPlacement.Saved? _saved = SavedPlacement.Read();
    private PhotinoWindow? _window;
    /// <summary>The window's last place and size while it was neither maximized nor minimized: the one it comes back to.</summary>
    private Rectangle? _normal;
    private int _changes;
    private volatile bool _closed;

    public LinuxPlacement() => _normal = _saved is { } s ? new Rectangle((int)s.X, (int)s.Y, (int)s.Width, (int)s.Height) : null;

    /// <summary>The place and size the window opens at: where it was last, else <paramref name="fallback"/>.</summary>
    public Rectangle Start(Rectangle fallback) => _normal ?? fallback;

    /// <summary>
    /// The window exists (on its thread): a saved place whose title bar is on no monitor goes back to
    /// <paramref name="fallback"/>, and a window closed maximized is maximized again.
    /// </summary>
    public void Restore(PhotinoWindow window, Rectangle fallback)
    {
        _window = window;
        if (_normal is { } normal && !TitleBarShows(window, normal))
        {
            _normal = null;
            window.SetLocation(fallback.Location);
            window.SetSize(fallback.Size);
        }
        var maximize = _saved is { Maximized: true } && _normal is not null;
        // Maximized before it ever moves, it comes back to where it opened.
        _normal ??= fallback;
        if (maximize)
        {
            window.SetMaximized(true);
        }
    }

    /// <summary>The window moved or was resized: once it keeps still, its place counts if it's a normal window then.</summary>
    public void Changed()
    {
        var change = Interlocked.Increment(ref _changes);
        Task.Delay(Settle).ContinueWith(_ =>
        {
            if (change == Volatile.Read(ref _changes) && !_closed && _window is { } window)
            {
                window.Invoke(() => Settled(window));
            }
        }, TaskScheduler.Default);
    }

    private void Settled(PhotinoWindow window)
    {
        if (!_closed && !window.Maximized && !window.Minimized)
        {
            _normal = new Rectangle(window.Location, window.Size);
        }
    }

    /// <summary>Remembers where the window is now, maximized or not; called on its thread as it closes.</summary>
    public void Save()
    {
        if (_window is not { } window || _closed)
        {
            return;
        }
        _closed = true;
        var maximized = window.Maximized;
        var frame = maximized || window.Minimized ? _normal : new Rectangle(window.Location, window.Size);
        if (frame is { } f)
        {
            SavedPlacement.Write(new SavedPlacement.Saved(f.X, f.Y, f.Width, f.Height, maximized));
        }
    }

    /// <summary>Whether the middle of the frame's title bar is on one of the monitors (their usable areas).</summary>
    private static bool TitleBarShows(PhotinoWindow window, Rectangle frame)
    {
        var point = new Point(frame.X + frame.Width / 2, frame.Y + TitleBarDepth);
        return window.Monitors.Any(m => m.WorkArea.Contains(point));
    }
}
