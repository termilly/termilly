using System.Collections.Concurrent;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// Runs port forwards (Settings › SSH): one hidden `ssh -N` per forward, started and stopped on request, with
/// its state reported as it changes: starting, running, stopped, or failed with ssh's last message. A forward
/// that can't sign in without asking (a password and no reference) fails at once rather than waiting unseen.
/// </summary>
internal sealed class ForwardManager : IDisposable
{
    /// <summary>The Windows OpenSSH client, else whichever ssh is on PATH (Git's on Windows).</summary>
    private static readonly string Ssh = SshConnections.OpenSshProgram(SshConnections.SshProgram);

    /// <summary>How long ssh has to stay up before the forward counts as running.</summary>
    private static readonly TimeSpan Settle = TimeSpan.FromSeconds(2.5);

    private readonly Action<string, string, string?> _changed;
    private readonly ConcurrentDictionary<string, Process> _running = new();

    /// <param name="changed">Called on a pool thread with a forward's id, state and message.</param>
    public ForwardManager(Action<string, string, string?> changed) => _changed = changed;

    public bool IsRunning(string id) => _running.ContainsKey(id);

    public void Start(PortForward forward, string destinationArguments, IReadOnlyDictionary<string, string>? environment)
    {
        if (_running.ContainsKey(forward.Id))
        {
            return;
        }
        Process process;
        try
        {
            process = StartSsh(SshConnections.ForwardArguments(forward, destinationArguments, batch: environment is null), environment);
        }
        catch (Win32Exception e)
        {
            _changed(forward.Id, ForwardStates.Failed, $"ssh couldn't start: {e.Message}");
            return;
        }
        _running[forward.Id] = process;
        _changed(forward.Id, ForwardStates.Starting, null);
        Follow(forward.Id, process);
    }

    /// <summary>A hidden ssh with nothing to type into: an unexpected question ends it instead of hanging.</summary>
    private static Process StartSsh(string arguments, IReadOnlyDictionary<string, string>? environment)
    {
        var start = new ProcessStartInfo(Ssh, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
            RedirectStandardInput = true,
        };
        foreach (var (name, value) in environment ?? new Dictionary<string, string>())
        {
            start.Environment[name] = value;
        }
        var process = Process.Start(start)!;
        process.StandardInput.Close();
        return process;
    }

    /// <summary>Reports a forward's state as its ssh runs: running once it has stayed up a moment, then how it ended.</summary>
    private void Follow(string id, Process process)
    {
        string? lastError = null;
        process.ErrorDataReceived += (_, e) =>
        {
            if (!string.IsNullOrWhiteSpace(e.Data))
            {
                lastError = e.Data.Trim();
            }
        };
        process.BeginErrorReadLine();
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) =>
        {
            var stopped = !_running.TryRemove(id, out _); // Stop() removed it first: on purpose
            _changed(id, stopped ? ForwardStates.Stopped : ForwardStates.Failed, stopped ? null : lastError ?? $"ssh exited ({process.ExitCode})");
            process.Dispose();
        };
        _ = Task.Delay(Settle).ContinueWith(_ =>
        {
            if (_running.TryGetValue(id, out var p) && p == process && !process.HasExited)
            {
                _changed(id, ForwardStates.Running, null);
            }
        }, TaskScheduler.Default);
    }

    public void Stop(string id)
    {
        if (_running.TryRemove(id, out var process))
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
                // Already gone.
            }
        }
    }

    public void Dispose()
    {
        foreach (var id in _running.Keys.ToList())
        {
            Stop(id);
        }
    }
}
