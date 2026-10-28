using System.Collections.Concurrent;
using System.IO;
using Termilly.Desktop.Features;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Files open in the preview's tabs are watched (PreviewWatch.cs): a change, deletion or return is told to the page.</summary>
public sealed class PreviewWatchTests : IDisposable
{
    private static readonly TimeSpan Patience = TimeSpan.FromSeconds(5);

    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-watch-").FullName;
    private readonly Sink _sink = new();
    private readonly PreviewWatchHandler _watch;

    public PreviewWatchTests() => _watch = new PreviewWatchHandler(new PageChannel(_sink));

    public void Dispose()
    {
        _watch.Dispose();
        Directory.Delete(_dir, recursive: true);
    }

    private sealed class Sink : IPageSink
    {
        public BlockingCollection<string> Sent { get; } = [];

        public void Send(string json) => Sent.Add(json);
    }

    /// <summary>The next message the page gets, or null when none comes in time.</summary>
    private string? Next() => _sink.Sent.TryTake(out var json, Patience) ? json : null;

    [Fact]
    public void A_change_and_a_deletion_are_told_with_the_path_the_page_sent()
    {
        var file = Path.Combine(_dir, "notes.md");
        File.WriteAllText(file, "one");
        var asSent = file.Replace('\\', '/'); // the page may write slashes
        _watch.Watch([asSent]);

        File.WriteAllText(file, "two");
        var changed = Next();
        Assert.NotNull(changed);
        Assert.Contains("\"type\":\"preview:fileChanged\"", changed);
        Assert.Contains($"\"path\":\"{asSent}\"", changed);
        Assert.Contains("\"exists\":true", changed);

        File.Delete(file);
        Assert.Contains("\"exists\":false", Next());
    }

    [Fact]
    public void Files_no_longer_open_are_not_told()
    {
        var file = Path.Combine(_dir, "a.txt");
        File.WriteAllText(file, "one");
        _watch.Watch([file]);
        _watch.Watch([]);

        File.WriteAllText(file, "two");
        Assert.False(_sink.Sent.TryTake(out _, TimeSpan.FromSeconds(1)));
    }
}
