using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>A terminal's shell, run in this process or by the background host.</summary>
internal interface IShellSession : IDisposable
{
    int ProcessId { get; }
    void Write(string text);
    void Resize(int columns, int rows);
}

/// <summary>
/// The window's side of the background host (Termilly.Host): starts it if it isn't running, and runs shells in it
/// so they outlive the window (Settings › Workspaces › Keep shells running). Output for each shell goes to the
/// session that asked for it.
/// </summary>
internal sealed class HostClient : IDisposable
{
    public static string HostExe => Path.Combine(AppContext.BaseDirectory, HostFolder, AppPaths.Exe(HostExeName));

    /// <summary>The host's folder next to the app, and its program.</summary>
    private const string HostFolder = "host";
    private const string HostExeName = "termilly-host";
    private const int ConnectAttempts = 3;
    /// <summary>A host that's running answers at once; one just started may need a few seconds to listen.</summary>
    private const int FirstConnectMs = 300;
    private const int StartingConnectMs = 5000;
    private static readonly TimeSpan HelloWait = TimeSpan.FromSeconds(3);
    /// <summary>Before trying again when the host dropped the connection while replacing its pipe.</summary>
    private static readonly TimeSpan RetryDelay = TimeSpan.FromMilliseconds(200);
    internal static readonly TimeSpan StartWait = TimeSpan.FromSeconds(5);

    private readonly NamedPipeClientStream _pipe;
    private readonly Lock _writeGate = new();
    private readonly ConcurrentDictionary<string, HostedSession> _sessions = new();
    private readonly TaskCompletionSource<HostEvent.Hello> _hello = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private volatile bool _closed;

    private HostClient(NamedPipeClientStream pipe)
    {
        _pipe = pipe;
        new Thread(ReadLoop) { IsBackground = true, Name = "host-client" }.Start();
    }

    /// <summary>Whether the host is still there (it isn't after "Stop background shells", or if it was ended).</summary>
    public bool IsConnected => !_closed;

    /// <summary>Shells the host already runs (from before this window opened): id → process id, alive or exited.</summary>
    public IReadOnlyDictionary<string, (int Pid, bool Alive)> Running { get; private set; } = new Dictionary<string, (int, bool)>();

    /// <summary>Connects to the host, starting it first if needed; null when it can't be reached.</summary>
    public static HostClient? Connect()
    {
        for (var attempt = 0; attempt < ConnectAttempts; attempt++)
        {
            var pipe = new NamedPipeClientStream(".", HostProtocol.PipeName, PipeDirection.InOut, PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
            try
            {
                pipe.Connect(attempt == 0 ? FirstConnectMs : StartingConnectMs);
                var client = new HostClient(pipe);
                lock (client._writeGate)
                {
                    HostProtocol.Write(pipe, new HostRequest.Hello(HostProtocol.Version));
                }
                HostEvent.Hello? hello;
                try
                {
                    hello = client._hello.Task.Wait(HelloWait) ? client._hello.Task.Result : null;
                }
                catch (AggregateException)
                {
                    // Dropped at once: the host was just replacing the pipe a window had left. Try again.
                    client.Dispose();
                    Thread.Sleep(RetryDelay);
                    continue;
                }
                if (hello?.V != HostProtocol.Version)
                {
                    client.Dispose(); // an older or newer host: this window runs its shells itself
                    return null;
                }
                client.Running = hello.Sessions.ToDictionary(s => s.Id, s => (s.Pid, s.Alive));
                return client;
            }
            catch (Exception e) when (e is TimeoutException or IOException or UnauthorizedAccessException)
            {
                pipe.Dispose();
                if (attempt == 0 && File.Exists(HostExe))
                {
                    Process.Start(new ProcessStartInfo(HostExe) { UseShellExecute = false, CreateNoWindow = true, WorkingDirectory = Path.GetDirectoryName(HostExe)! });
                }
                else
                {
                    return null;
                }
            }
        }
        return null;
    }

    /// <summary>Runs a new shell in the host (replacing one with the same id).</summary>
    public HostedSession Start(string id, PtyOptions options, Action<string> onOutput, Action<int> onExit, Action<string> onFailed)
    {
        var session = new HostedSession(this, id, onOutput, onExit, onFailed);
        _sessions[id] = session;
        Send(new HostRequest.Start(id, options.CommandLine, options.Columns, options.Rows, options.WorkingDirectory, options.Environment));
        session.WaitStarted();
        return session;
    }

    /// <summary>Takes over a shell the host kept running: its missed output comes first, then the live output.</summary>
    public HostedSession Attach(string id, int pid, int cols, int rows, Action<string> onOutput, Action<int> onExit)
    {
        var session = new HostedSession(this, id, onOutput, onExit, _ => { }) { ProcessId = pid };
        _sessions[id] = session;
        Send(new HostRequest.Attach(id));
        Send(new HostRequest.Resize(id, cols, rows));
        return session;
    }

    public void Send(HostRequest message)
    {
        if (_closed)
        {
            return;
        }
        try
        {
            lock (_writeGate)
            {
                HostProtocol.Write(_pipe, message);
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            _closed = true;
        }
    }

    /// <summary>Ends every shell and the host itself (Settings › Stop background shells).</summary>
    public void Shutdown() => Send(new HostRequest.Shutdown());

    internal void Forget(string id) => _sessions.TryRemove(id, out _);

    private void ReadLoop()
    {
        try
        {
            while (HostProtocol.ReadEvent(_pipe) is { } e)
            {
                switch (e)
                {
                    case HostEvent.Hello hello:
                        _hello.TrySetResult(hello);
                        break;
                    case HostEvent.Started started:
                        SessionOf(started.Id)?.Started(started.Pid);
                        break;
                    case HostEvent.Failed failed:
                        SessionOf(failed.Id)?.Failed(failed.Message);
                        break;
                    case HostEvent.Output output:
                        SessionOf(output.Id)?.Output(output.Data);
                        break;
                    case HostEvent.Replay replay:
                        SessionOf(replay.Id)?.Output(replay.Data);
                        break;
                    case HostEvent.Exited exit:
                        SessionOf(exit.Id)?.Exit(exit.Code);
                        break;
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or System.Text.Json.JsonException)
        {
        }
        _closed = true;
        _hello.TrySetCanceled();
    }

    private HostedSession? SessionOf(string id) => _sessions.TryGetValue(id, out var session) ? session : null;

    /// <summary>The window is closing: the shells stay with the host.</summary>
    public void Dispose()
    {
        _closed = true;
        _pipe.Dispose();
    }
}

/// <summary>A shell the background host runs, as the window sees it.</summary>
internal sealed class HostedSession : IShellSession
{
    /// <summary>The exit code the page gets for a shell that ended with the background host ("Stop background shells").</summary>
    public const int EndedCode = -1;

    private readonly HostClient _host;
    private readonly string _id;
    private readonly Action<string> _onOutput;
    private readonly Action<int> _onExit;
    private readonly Action<string> _onFailed;
    private readonly ManualResetEventSlim _started = new();
    private volatile bool _killed;

    internal HostedSession(HostClient host, string id, Action<string> onOutput, Action<int> onExit, Action<string> onFailed)
    {
        _host = host;
        _id = id;
        _onOutput = onOutput;
        _onExit = onExit;
        _onFailed = onFailed;
    }

    public int ProcessId { get; internal set; }

    /// <summary>Waits briefly for the host to report the process id (the busy watcher needs it).</summary>
    internal void WaitStarted() => _started.Wait(HostClient.StartWait);

    internal void Started(int pid)
    {
        ProcessId = pid;
        _started.Set();
    }

    internal void Failed(string message)
    {
        _started.Set();
        _onFailed(message);
    }

    internal void Output(string text)
    {
        if (!_killed)
        {
            _onOutput(text);
        }
    }

    internal void Exit(int code)
    {
        if (!_killed)
        {
            _onExit(code);
        }
    }

    public void Write(string text) => _host.Send(new HostRequest.Input(_id, text));

    public void Resize(int columns, int rows) => _host.Send(new HostRequest.Resize(_id, columns, rows));

    /// <summary>The terminal was closed: the host ends its shell.</summary>
    public void Dispose()
    {
        _killed = true;
        _host.Forget(_id);
        _host.Send(new HostRequest.Kill(_id));
    }
}
