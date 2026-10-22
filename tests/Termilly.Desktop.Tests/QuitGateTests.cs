using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Quitting asks the page first (QuitGate): its answer decides, and a page that never answers can't stop it.</summary>
public sealed class QuitGateTests
{
    private static readonly TimeSpan Short = TimeSpan.FromMilliseconds(50);
    private static readonly TimeSpan Plenty = TimeSpan.FromSeconds(5);

    private sealed class Sink : IPageSink
    {
        public List<string> Sent { get; } = [];

        public void Send(string json) => Sent.Add(json);
    }

    [Fact]
    public void Asking_tells_the_page_and_quit_closes()
    {
        var sink = new Sink();
        using var gate = new QuitGate(new PageChannel(sink), Plenty);
        var closed = 0;

        gate.Ask(() => closed++);

        Assert.Contains("\"quit:ask\"", sink.Sent.Single(), StringComparison.Ordinal);
        Assert.False(gate.Quitting);
        gate.Answer(QuitAnswers.Quit);
        Assert.Equal(1, closed);
        Assert.True(gate.Quitting);
    }

    [Fact]
    public void Stay_keeps_it_running_and_asking_waits_for_the_user()
    {
        using var gate = new QuitGate(new PageChannel(new Sink()), Short);
        var closed = 0;

        gate.Ask(() => closed++);
        gate.Answer(QuitAnswers.Asking);
        Thread.Sleep(Short * 4); // the user is deciding: no quitting behind their back
        Assert.Equal(0, closed);
        gate.Answer(QuitAnswers.Stay);
        gate.Answer(QuitAnswers.Quit); // a late answer to a question already settled closes nothing
        Assert.Equal(0, closed);
        Assert.False(gate.Quitting);
    }

    [Fact]
    public void A_page_that_never_answers_doesnt_keep_Termilly_open()
    {
        using var gate = new QuitGate(new PageChannel(new Sink()), Short);
        using var closed = new ManualResetEventSlim();

        gate.Ask(closed.Set);

        Assert.True(closed.Wait(Plenty));
        Assert.True(gate.Quitting);
    }
}
