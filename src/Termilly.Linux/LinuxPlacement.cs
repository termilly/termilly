using System.Drawing;
using Photino.NET;

namespace Termilly.Linux;

/// <summary>
/// Where the main window was on Linux and whether it was maximized, kept in window.json (<see cref="SavedPlacement"/>)
/// and put back the next time Termilly opens, as on Windows and macOS. In GTK's coordinates, as Photino and the
/// monitors' work areas give them. A place whose title bar is on no monitor now is left out; native Wayland, which
/// tells no window where it is, keeps only the size. Everything here runs on the window's thread.
/// </summary>
internal sealed class LinuxPlacement
{
    /// <summary>
    /// How long a place must stand before it counts as the window's normal one: maximizing and minimizing move and
    /// resize it too, and the desktop may say so before it says it's maximized.
    /// </summary>
    private static readonly TimeSpan Settle = TimeSpan.FromMilliseconds(400);
    /// <summary>How far down from a window's top its title bar is looked for on the monitors, in pixels.</summary>
    private const int TitleBarDepth = 20;

    /// <summary>A place the window was at as a normal window, and when it got there.</summary>
    private readonly record struct Seen(Rectangle Frame, long At);

    private readonly SavedPlacement.Saved? _saved = SavedPlacement.Read();
    private PhotinoWindow? _window;
    /// <summary>The window's last settled place and size as a normal window: the one it comes back to.</summary>
    private Rectangle? _normal;
    /// <summary>The newest place it was at as a normal window, not settled yet.</summary>
    private Seen? _latest;
    private bool _closed;
    private readonly TimeProvider _clock;

    /// <param name="clock">When places were taken, to tell those a window stood at from those it passed through.</param>
    public LinuxPlacement(TimeProvider clock)
    {
        _clock = clock;
        _normal = _saved is { } s ? new Rectangle((int)s.X, (int)s.Y, (int)s.Width, (int)s.Height) : null;
    }

    /// <summary>The place and size the window opens at: where it was last, else <paramref name="fallback"/>.</summary>
    public Rectangle Start(Rectangle fallback) =>
        _normal is { } normal ? new Rectangle(GtkWindow.PlacesWindows ? normal.Location : fallback.Location, normal.Size) : fallback;

    /// <summary>
    /// The window exists: a saved place whose title bar is on no monitor goes back to <paramref name="fallback"/>, and a
    /// window closed maximized is maximized again.
    /// </summary>
    public void Restore(PhotinoWindow window, Rectangle fallback)
    {
        _window = window;
        if (_normal is { } normal && GtkWindow.PlacesWindows && !TitleBarShows(window, normal))
        {
            _normal = null;
            window.SetLocation(fallback.Location);
            window.SetSize(fallback.Size);
        }
        // Maximized before it ever moves, it comes back to where it opened.
        _normal ??= new Rectangle(window.Location, window.Size);
        if (_saved is { Maximized: true })
        {
            window.SetMaximized(true);
        }
    }

    /// <summary>The window moved or was resized.</summary>
    public void Moved()
    {
        if (_window is not { } window || _closed || window.Maximized || window.Minimized)
        {
            return;
        }
        SettleLatest();
        _latest = new Seen(new Rectangle(window.Location, window.Size), _clock.GetTimestamp());
    }

    /// <summary>
    /// The window was maximized or minimized: a place it took just before was that change's own, not one it stood at.
    /// Restored, it isn't maximized any more, and its next move counts.
    /// </summary>
    public void StateChanged()
    {
        if (_window is { } window && (window.Maximized || window.Minimized) && _latest is { } latest && !HasSettled(latest))
        {
            _latest = null;
        }
        SettleLatest();
    }

    /// <summary>Remembers where the window is now, maximized or not; called as it closes.</summary>
    public void Save()
    {
        if (_window is not { } window || _closed)
        {
            return;
        }
        _closed = true;
        var maximized = window.Maximized;
        var frame = maximized || window.Minimized ? (_latest is { } latest && HasSettled(latest) ? latest.Frame : _normal)
            : new Rectangle(window.Location, window.Size);
        if (frame is not { } f)
        {
            return;
        }
        // Native Wayland says the window is at 0,0: the place it had before stays.
        var place = GtkWindow.PlacesWindows || _saved is null ? f.Location : new Point((int)_saved.X, (int)_saved.Y);
        SavedPlacement.Write(new SavedPlacement.Saved(place.X, place.Y, f.Width, f.Height, maximized));
    }

    private bool HasSettled(Seen seen) => _clock.GetElapsedTime(seen.At) >= Settle;

    private void SettleLatest()
    {
        if (_latest is { } latest && HasSettled(latest))
        {
            _normal = latest.Frame;
            _latest = null;
        }
    }

    /// <summary>Whether the middle of the frame's title bar is on one of the monitors (their usable areas).</summary>
    private static bool TitleBarShows(PhotinoWindow window, Rectangle frame)
    {
        var point = new Point(frame.X + frame.Width / 2, frame.Y + TitleBarDepth);
        return window.Monitors.Any(m => m.WorkArea.Contains(point));
    }
}
