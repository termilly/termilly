using System.Collections.Concurrent;
using System.IO;
using System.Text;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>What a hidden shell runs, and how long it may take.</summary>
internal sealed record ScheduleJob(string RunId, PtyOptions Options, TimeSpan Limit);

/// <summary>How a hidden shell ended: its exit code unless it was stopped, and the end of what it printed.</summary>
internal sealed record ScheduleResult(int? ExitCode, string Output, bool Stopped);

/// <summary>
/// What a run printed, as the terminal printed it: the end of it, when it's long. A hidden shell is a real pseudo terminal, so
/// its programs print as they would in a terminal and the report can be opened as one.
/// </summary>
internal sealed class ScheduleOutput(int maxChars)
{
    private readonly StringBuilder _text = new();

    public void Add(string data)
    {
        _text.Append(data);
        // Cut when it's half as long again: a cut on every chunk would move the whole text each time.
        if (_text.Length > maxChars + (maxChars / 2))
        {
            _text.Remove(0, _text.Length - maxChars);
        }
    }

    public override string ToString() => _text.Length > maxChars ? _text.ToString(_text.Length - maxChars, maxChars) : _text.ToString();
}

/// <summary>Hidden shells: each runs in a pseudo terminal nobody sees, and ends by itself, by <see cref="Stop"/> or at its limit.</summary>
internal sealed class ScheduleRunner(Func<PtyOptions, IPty> start) : IDisposable
{
    /// <summary>The most of a run's output that's kept.</summary>
    public const int MaxOutputChars = 1024 * 1024;
    /// <summary>The size of a hidden shell's terminal: wide, so a report's lines aren't folded.</summary>
    public const int Columns = 160;
    public const int Rows = 50;
    /// <summary>How long what a shell printed last may take to arrive after it ended, or after it was stopped.</summary>
    private static readonly TimeSpan DrainFor = TimeSpan.FromSeconds(2);

    private sealed record Running(CancellationTokenSource Stop);

    private readonly ConcurrentDictionary<string, Running> _running = new();

    public async Task<ScheduleResult> RunAsync(ScheduleJob job)
    {
        using var stop = new CancellationTokenSource(job.Limit);
        var pty = start(job.Options);
        _running[job.RunId] = new Running(stop);
        try
        {
            var output = new ScheduleOutput(MaxOutputChars);
            var pump = Task.Run(() => Pump(pty, output), CancellationToken.None);
            if (await EndedOrStoppedAsync(pty, stop.Token).ConfigureAwait(false))
            {
                pty.Dispose(); // closes the terminal, and what runs in it with it
                await Finished(pump).ConfigureAwait(false);
                return new ScheduleResult(null, output.ToString(), true);
            }
            await Finished(pump).ConfigureAwait(false);
            var code = await pty.Exited.ConfigureAwait(false);
            pty.Dispose();
            return new ScheduleResult(code, output.ToString(), false);
        }
        finally
        {
            _running.TryRemove(job.RunId, out _);
        }
    }

    public void Stop(string runId)
    {
        if (_running.TryGetValue(runId, out var run))
        {
            run.Stop.Cancel();
        }
    }

    public void Dispose()
    {
        foreach (var run in _running.Values)
        {
            run.Stop.Cancel();
        }
    }

    /// <summary>True when it was stopped before it ended.</summary>
    private static async Task<bool> EndedOrStoppedAsync(IPty pty, CancellationToken stop)
    {
        try
        {
            await pty.Exited.WaitAsync(stop).ConfigureAwait(false);
            return false;
        }
        catch (OperationCanceledException)
        {
            return true;
        }
    }

    private static async Task Finished(Task pump)
    {
        try
        {
            await pump.WaitAsync(DrainFor).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            // Something it started still holds the terminal open: the report is what there is so far.
        }
    }

    private static void Pump(IPty pty, ScheduleOutput output)
    {
        var buffer = new byte[TerminalStreams.ReadSize];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(buffer.Length)];
        var decoder = Encoding.UTF8.GetDecoder();
        try
        {
            int read;
            while ((read = pty.Output.Read(buffer, 0, buffer.Length)) > 0)
            {
                lock (output)
                {
                    output.Add(new string(chars, 0, decoder.GetChars(buffer, 0, read, chars, 0)));
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // The terminal closed under it, as it does when a run is stopped.
        }
    }
}
