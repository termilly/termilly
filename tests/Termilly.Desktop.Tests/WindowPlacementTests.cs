using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class WindowPlacementTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public WindowPlacementTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void The_place_a_window_closed_in_is_read_back()
    {
        var file = Path.Combine(_dir, "window.json");
        WindowPlacement.Write(file, new WindowPlacement.Saved(-1800, 40, -200, 940, Maximized: true));

        Assert.Equal(new WindowPlacement.Saved(-1800, 40, -200, 940, true), WindowPlacement.Read(file));
    }

    [Theory]
    [InlineData(1950, 100, 800, 600, 1120, 100, 800, 600)] // on the second monitor, gone: to the right edge of the first
    [InlineData(-900, -50, 800, 600, 0, 0, 800, 600)] // left of and above it
    [InlineData(2500, 900, 3000, 2000, 0, 0, 1920, 1040)] // bigger than the monitor: shrunk to it
    [InlineData(100, 100, 800, 600, 100, 100, 800, 600)] // already there
    public void A_place_on_a_monitor_thats_gone_comes_within_the_one_left(int x, int y, int width, int height, int toX, int toY, int toWidth, int toHeight)
    {
        var work = new System.Windows.Int32Rect(0, 0, 1920, 1040);

        Assert.Equal(new System.Windows.Int32Rect(toX, toY, toWidth, toHeight), WindowPlacement.Within(new System.Windows.Int32Rect(x, y, width, height), work));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""{"Left":10,"Top":10,"Right":60,"Bottom":40,"Maximized":false}""")]
    public void A_missing_damaged_or_tiny_place_opens_the_window_as_new(string text)
    {
        var file = Path.Combine(_dir, "window.json");
        if (text.Length > 0)
        {
            File.WriteAllText(file, text);
        }

        Assert.Null(WindowPlacement.Read(file));
    }
}
