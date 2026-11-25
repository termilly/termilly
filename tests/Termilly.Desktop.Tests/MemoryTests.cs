using System.Windows;

namespace Termilly.Desktop.Tests;

/// <summary>Low memory's browser arguments and when a window's WebView2 may give memory back.</summary>
public sealed class MemoryTests
{
    [Fact]
    public void Low_memory_starts_the_browser_without_the_gpu()
    {
        Assert.Equal("--disable-gpu", BrowserArguments.For(lowMemory: true, devToolsPort: null));
        Assert.Equal("--remote-debugging-port=9301 --disable-gpu", BrowserArguments.For(lowMemory: true, devToolsPort: 9301));
    }

    [Fact]
    public void Without_low_memory_the_browser_starts_as_before()
    {
        Assert.Null(BrowserArguments.For(lowMemory: false, devToolsPort: null));
        Assert.Equal("--remote-debugging-port=9301", BrowserArguments.For(lowMemory: false, devToolsPort: 9301));
    }

    [Theory]
    [InlineData(true, WindowState.Normal, false)]
    [InlineData(true, WindowState.Maximized, false)]
    [InlineData(true, WindowState.Minimized, true)]
    [InlineData(false, WindowState.Normal, true)]
    public void A_window_minimized_or_hidden_is_out_of_sight(bool visible, WindowState state, bool outOfSight) =>
        Assert.Equal(outOfSight, BackgroundMemory.OutOfSight(visible, state));
}
