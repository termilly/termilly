namespace Termilly.Desktop.Phone;

/// <summary>
/// How many connections a server serves at once, at most: one past that isn't served, so a flood of connections
/// can't start a task each without end.
/// </summary>
internal sealed class ConnectionLimit(int max)
{
    private int _busy;

    /// <summary>Serves one connection in the background if there's a slot for it, else says no (it isn't served).</summary>
    public bool TryStart(Func<Task> serve)
    {
        if (Interlocked.Increment(ref _busy) > max)
        {
            Interlocked.Decrement(ref _busy);
            return false;
        }
        _ = Task.Run(async () =>
        {
            try
            {
                await serve();
            }
            finally
            {
                Interlocked.Decrement(ref _busy);
            }
        });
        return true;
    }

    /// <summary>The slots free now.</summary>
    public int Free => max - Volatile.Read(ref _busy);
}
