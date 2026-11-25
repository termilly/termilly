using System.Runtime.Versioning;
using Termilly.Linux;

namespace Termilly.Core.Tests;

/// <summary>Keeping the macOS main window on its screen (WindowFit, used by MacPlacement).</summary>
[SupportedOSPlatform("macos")] // only arithmetic: runs anywhere
public sealed class WindowFitTests
{
    // A 1280x800 screen but its menu bar (25) and Dock (60), and a second screen to its right.
    private static readonly Rect Laptop = new(0, 60, 1280, 715);
    private static readonly Rect Monitor = new(1280, 0, 1920, 1055);

    [Fact]
    public void A_place_that_fits_comes_back_as_it_was()
    {
        var frame = new Rect(100, 100, 900, 500);
        Assert.Equal(frame, WindowFit.Placed(frame, [Laptop]));
    }

    [Fact]
    public void A_window_taller_than_the_screen_is_shrunk_onto_it()
    {
        // The first start's 1280x820 on a 1280x800 screen: macOS put its title bar under the menu bar, so it was dropped.
        Assert.Equal(new Rect(0, 60, 1280, 715), WindowFit.Placed(new Rect(0, -20, 1280, 820), [Laptop]));
    }

    [Fact]
    public void A_place_partly_off_the_screen_is_moved_back_without_shrinking()
    {
        Assert.Equal(new Rect(380, 60, 900, 500), WindowFit.Placed(new Rect(600, 40, 900, 500), [Laptop]));
    }

    [Fact]
    public void It_goes_to_the_screen_its_title_bar_is_on()
    {
        var placed = WindowFit.Placed(new Rect(1100, 300, 1000, 600), [Laptop, Monitor]);
        Assert.Equal(new Rect(1280, 300, 1000, 600), placed); // the title bar's middle (1600) is on the monitor
    }

    [Fact]
    public void A_place_on_no_screen_now_is_left_out()
    {
        Assert.Null(WindowFit.Placed(new Rect(4000, 100, 900, 500), [Laptop, Monitor])); // a display that's gone
    }
}
