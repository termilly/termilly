using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Work run in the order it came (InOrder.cs): what keeps a server's hook reports in order.</summary>
public sealed class InOrderTests
{
    [Fact]
    public async Task Items_run_one_at_a_time_in_the_order_they_came()
    {
        var done = new List<int>();
        var running = 0;
        var overlapped = false;
        var queue = new InOrder<int>(n =>
        {
            overlapped |= Interlocked.Increment(ref running) > 1;
            Thread.Sleep(n % 2 == 0 ? 20 : 0); // the slow ones would finish last on pool threads of their own
            lock (done)
            {
                done.Add(n);
            }
            Interlocked.Decrement(ref running);
        });
        Task last = Task.CompletedTask;
        for (var i = 0; i < 10; i++)
        {
            last = queue.Add(i);
        }
        await last;
        Assert.Equal(Enumerable.Range(0, 10), done);
        Assert.False(overlapped);
    }

    [Fact]
    public async Task An_item_that_throws_does_not_stop_the_next()
    {
        var done = new List<string>();
        var queue = new InOrder<string>(s =>
        {
            if (s == "bad")
            {
                throw new InvalidOperationException(s);
            }
            done.Add(s);
        });
        var bad = queue.Add("bad");
        await queue.Add("good");
        Assert.True(bad.IsFaulted);
        Assert.Equal(["good"], done);
    }
}
