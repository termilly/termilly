using System.IO;
using System.Text.Json;

namespace Termilly.Desktop.Tests;

public sealed class RecordingTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), $"termilly-cast-{Guid.NewGuid():N}");

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    [Fact]
    public void A_recording_is_an_asciicast_v2_file()
    {
        var path = Recording.PathFor(_dir, "api: server", new DateTime(2026, 10, 12, 5, 30, 0));
        using (var cast = new Recording(path, 120, 30, "api: server", redact: true))
        {
            cast.Output("hello \u001b[32mworld\u001b[0m\r\n");
            cast.Mark("npm test");
            cast.Resize(100, 40);
            cast.Output("token=ghp_0123456789abcdefghijklmnopqrstuvwxyz\r\n");
        }

        Assert.EndsWith(@"api server_2026-10-12_05-30-00.cast", path);
        var lines = File.ReadAllLines(path);
        using var header = JsonDocument.Parse(lines[0]);
        Assert.Equal((2, 120, 30), (header.RootElement.GetProperty("version").GetInt32(), header.RootElement.GetProperty("width").GetInt32(), header.RootElement.GetProperty("height").GetInt32()));

        var events = lines[1..].Select(l => JsonDocument.Parse(l).RootElement).ToList();
        Assert.Equal(["o", "m", "r", "o"], events.Select(e => e[1].GetString()));
        Assert.Equal("hello \u001b[32mworld\u001b[0m\r\n", events[0][2].GetString());
        Assert.Equal("100x40", events[2][2].GetString());
        Assert.DoesNotContain("ghp_", events[3][2].GetString());
        Assert.True(events.Zip(events.Skip(1)).All(p => p.First[0].GetDouble() <= p.Second[0].GetDouble()));
    }

    [Fact]
    public void A_recording_stops_at_its_size_cap()
    {
        var path = Path.Combine(_dir, "big.cast");
        using var cast = new Recording(path, 80, 24, "big", redact: false, maxBytes: 1000);

        cast.Output(new string('x', 2000));
        cast.Output("after");

        Assert.True(cast.Full);
        Assert.DoesNotContain("after", File.ReadAllText(path));
    }
}
