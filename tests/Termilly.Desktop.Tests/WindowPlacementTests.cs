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
