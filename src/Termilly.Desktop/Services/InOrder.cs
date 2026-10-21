namespace Termilly.Desktop.Services;

/// <summary>
/// Runs work off the caller's thread, one item at a time and in the order the items came. A pool thread per item
/// (Task.Run) would let a later item finish first. An item that throws doesn't stop the ones after it.
/// </summary>
internal sealed class InOrder<T>(Action<T> work)
{
    private readonly Lock _gate = new();
    private Task _last = Task.CompletedTask;

    /// <summary>Queues an item; the task completes when it has run (faulted if it threw).</summary>
    public Task Add(T item)
    {
        lock (_gate)
        {
            return _last = _last.ContinueWith(_ => work(item), CancellationToken.None, TaskContinuationOptions.None, TaskScheduler.Default);
        }
    }
}
