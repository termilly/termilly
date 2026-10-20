using System.IO;
using System.Text;
using Termilly.Pty;

namespace Termilly.Desktop.Tests;

public sealed class HostProtocolTests
{
    [Fact]
    public void Frames_round_trip_and_a_closed_stream_ends_reading()
    {
        using var requests = new MemoryStream();
        HostProtocol.Write(requests, new HostRequest.Input("t1", "dir\r"));
        HostProtocol.Write(requests, new HostRequest.Shutdown());
        requests.Position = 0;
        using var events = new MemoryStream();
        HostProtocol.Write(events, new HostEvent.Output("t1", new string('x', 100_000) + "✓"));
        events.Position = 0;

        Assert.Equal(new HostRequest.Input("t1", "dir\r"), HostProtocol.ReadRequest(requests));
        Assert.IsType<HostRequest.Shutdown>(HostProtocol.ReadRequest(requests));
        Assert.Null(HostProtocol.ReadRequest(requests));
        Assert.EndsWith("✓", Assert.IsType<HostEvent.Output>(HostProtocol.ReadEvent(events)).Data);
        Assert.Null(HostProtocol.ReadEvent(events));
    }

    [Fact]
    public void The_records_keep_the_pipe_format_a_window_and_host_of_this_version_share()
    {
        using var stream = new MemoryStream();
        HostProtocol.Write(stream, new HostRequest.Input("t1", "dir\r"));
        HostProtocol.Write(stream, new HostEvent.Hello(HostProtocol.Version, [new HostEvent.Session("t1", 42, false, 0)]));

        var frames = Encoding.UTF8.GetString(stream.ToArray());
        Assert.Contains("""{"op":"input","id":"t1","d":"dir\r"}""", frames);
        Assert.Contains($$"""{"ev":"hello","v":{{HostProtocol.Version}},"sessions":[{"id":"t1","pid":42,"alive":false,"exit":0}]}""", frames);
    }

    [Fact]
    public void A_kind_this_version_does_not_know_is_skipped()
    {
        using var stream = new MemoryStream();
        var unknown = Encoding.UTF8.GetBytes("""{"op":"teleport","id":"t1"}""");
        stream.Write(BitConverter.GetBytes(unknown.Length));
        stream.Write(unknown);
        HostProtocol.Write(stream, new HostRequest.Kill("t1"));
        stream.Position = 0;

        Assert.Equal(new HostRequest.Kill("t1"), HostProtocol.ReadRequest(stream));
    }

    [Fact]
    public void A_frame_claiming_to_be_huge_is_refused()
    {
        using var stream = new MemoryStream([0xFF, 0xFF, 0xFF, 0x7F, 1, 2, 3]);
        Assert.Null(HostProtocol.ReadRequest(stream));
    }

    [Fact]
    public void The_output_ring_keeps_the_latest_output_within_its_size()
    {
        var ring = new OutputRing(capacity: 10);
        ring.Add("aaaa");
        ring.Add("bbbb");
        ring.Add("cccc");
        Assert.Equal("bbbbcccc", ring.Text());

        var one = new OutputRing(capacity: 3);
        one.Add("a long chunk is kept whole when it's the only one");
        Assert.StartsWith("a long", one.Text());
    }

    [Fact]
    public void The_pipe_is_per_windows_user() =>
        Assert.StartsWith("termilly-host-S-1-", HostProtocol.PipeName);
}
