namespace Termilly.Linux;

/// <summary>
/// Keeping a window on the screens: frames and screen areas in points, from the bottom left as Cocoa has them
/// (MacPlacement reads the screens).
/// </summary>
internal static class WindowFit
{
    /// <summary>How far down from a window's top its title bar is looked for on the screens, in points.</summary>
    private const double TitleBarDepth = 20;

    /// <summary>
    /// The frame moved and shrunk to lie inside the area its title bar is on, else the one it overlaps most; null when
    /// it's on none of them (a display that's gone).
    /// </summary>
    public static Rect? Placed(Rect frame, IReadOnlyList<Rect> areas)
    {
        var area = TitleBarOn(frame, areas)
            ?? areas.Where(a => Overlap(frame, a) > 0).OrderByDescending(a => Overlap(frame, a)).Cast<Rect?>().FirstOrDefault();
        return area is { } on ? Fit(frame, on) : null;
    }

    /// <summary>The frame, no bigger than the area and moved inside it as little as it takes.</summary>
    public static Rect Fit(Rect frame, Rect area)
    {
        var width = Math.Min(frame.Width, area.Width);
        var height = Math.Min(frame.Height, area.Height);
        var x = Math.Clamp(frame.X, area.X, area.X + area.Width - width);
        var y = Math.Clamp(frame.Y, area.Y, area.Y + area.Height - height);
        return new Rect(x, y, width, height);
    }

    /// <summary>The area holding the middle of the frame's title bar, if any.</summary>
    public static Rect? TitleBarOn(Rect frame, IReadOnlyList<Rect> areas)
    {
        double x = frame.X + frame.Width / 2, y = frame.Y + frame.Height - TitleBarDepth;
        return areas.Where(a => x >= a.X && x <= a.X + a.Width && y >= a.Y && y <= a.Y + a.Height).Cast<Rect?>().FirstOrDefault();
    }

    private static double Overlap(Rect a, Rect b) =>
        Math.Max(0, Math.Min(a.X + a.Width, b.X + b.Width) - Math.Max(a.X, b.X))
        * Math.Max(0, Math.Min(a.Y + a.Height, b.Y + b.Height) - Math.Max(a.Y, b.Y));
}
