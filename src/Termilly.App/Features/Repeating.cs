namespace Termilly.Desktop.Features;

/// <summary>Work done again and again while something needs it: a timer in the app, nothing in tests that tick by hand.</summary>
internal interface IRepeating : IDisposable
{
    /// <summary>Schedules the work at once (not on the caller's thread), then every <paramref name="every"/>.</summary>
    void Start(TimeSpan every);

    void Stop();
}

/// <summary>Repeats on a thread-pool timer.</summary>
internal sealed class TimerRepeating(Action work) : IRepeating
{
    private readonly Timer _timer = new(_ => work(), null, Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

    public void Start(TimeSpan every) => _timer.Change(TimeSpan.Zero, every);

    public void Stop() => _timer.Change(Timeout.InfiniteTimeSpan, Timeout.InfiniteTimeSpan);

    public void Dispose() => _timer.Dispose();
}
