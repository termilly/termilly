using Termilly.Desktop.Features;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Quitting disposes every service; one registered twice is disposed twice, and that must not throw.</summary>
public sealed class DisposeTwiceTests
{
    private sealed class Sink : IPageSink
    {
        public void Send(string json)
        {
        }
    }

    [Fact]
    public void Remote_computers_can_be_disposed_twice()
    {
        var handler = new RemotePcsHandler(new PageChannel(new Sink()), null!);

        handler.Dispose();
        handler.Dispose();
    }
}
