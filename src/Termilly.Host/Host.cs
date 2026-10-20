using System.Collections.Concurrent;
using System.IO.Pipes;
using System.Text;
using Termilly.Pty;

namespace Termilly.Host;

/// <summary>A shell the host runs: its pseudo terminal, the last of its output, and how it ended.</summary>
internal sealed class HostedShell(string id, IPty pty)
{
    public string Id { get; } = id;
    public IPty Pty { get; } = pty;
    public OutputRing Output { get; } = new();
    public int? ExitCode { get; set; }
    public bool Alive => ExitCode is null;
}

/// <summary>
/// Owns the shells for a Termilly window that may come and go (see HostProtocol). One window at a time is
/// attached: it gets every shell's output as it happens, and on attach the output it missed. With no window and
/// no shell left running, the host quits after a while.
/// </summary>
internal sealed class Host
{
    private static readonly TimeSpan IdleExit = TimeSpan.FromSeconds(60);
    /// <summary>How often the idle watch looks.</summary>
    private static readonly TimeSpan IdleCheck = TimeSpan.FromSeconds(5);
    /// <summary>How much of a shell's output is read at a time.</summary>
    private const int ReadSize = TerminalStreams.ReadSize;

    private readonly ConcurrentDictionary<string, HostedShell> _shells = new();
    private readonly Lock _clientGate = new();
    private NamedPipeServerStream? _client;
    private DateTime _idleSince = DateTime.UtcNow;
    private volatile bool _stopping;

    public int Run()
    {
        new Thread(IdleWatch) { IsBackground = true }.Start();
        while (!_stopping)
        {
            NamedPipeServerStream pipe;
            try
            {
                pipe = new NamedPipeServerStream(HostProtocol.PipeName, PipeDirection.InOut, 2, PipeTransmissionMode.Byte, PipeOptions.CurrentUserOnly | PipeOptions.Asynchronous); // overlapped: reading and writing at once
            }
            catch (IOException)
            {
                return 0; // another host already serves this user
            }
            try
            {
                pipe.WaitForConnection();
            }
            catch (IOException)
            {
                pipe.Dispose();
                continue;
            }
            Serve(pipe);
        }
        return 0;
    }

    /// <summary>Serves one window until it disconnects; a newer window replaces it.</summary>
    private void Serve(NamedPipeServerStream pipe)
    {
        lock (_clientGate)
        {
            _client?.Dispose();
            _client = pipe;
        }
        try
        {
            while (HostProtocol.ReadRequest(pipe) is { } message)
            {
                Handle(message);
                if (_stopping)
                {
                    break;
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException or System.Text.Json.JsonException)
        {
        }
        lock (_clientGate)
        {
            if (_client == pipe)
            {
                _client = null;
                _idleSince = DateTime.UtcNow;
            }
        }
        pipe.Dispose();
    }

    private void Handle(HostRequest request)
    {
        switch (request)
        {
            case HostRequest.Hello:
                Send(new HostEvent.Hello(HostProtocol.Version,
                    _shells.Values.Select(s => new HostEvent.Session(s.Id, s.Pty.ProcessId, s.Alive, s.ExitCode)).ToList()));
                break;
            case HostRequest.Start start:
                Start(start);
                break;
            case HostRequest.Attach attach when _shells.TryGetValue(attach.Id, out var shell):
                Send(new HostEvent.Replay(attach.Id, shell.Output.Text()));
                if (!shell.Alive)
                {
                    Send(new HostEvent.Exited(attach.Id, shell.ExitCode ?? HostEvent.UnknownExitCode));
                }
                break;
            case HostRequest.Input input when _shells.TryGetValue(input.Id, out var target) && target.Alive:
                try
                {
                    target.Pty.Input.Write(Encoding.UTF8.GetBytes(input.Data));
                    target.Pty.Input.Flush();
                }
                catch (IOException)
                {
                }
                break;
            case HostRequest.Resize resize when _shells.TryGetValue(resize.Id, out var resized) && resized.Alive:
                resized.Pty.Resize(resize.Cols, resize.Rows);
                break;
            case HostRequest.Kill kill when _shells.TryRemove(kill.Id, out var killed):
                killed.Pty.Dispose();
                break;
            case HostRequest.Shutdown:
                _stopping = true;
                foreach (var s in _shells.Values)
                {
                    s.Pty.Dispose();
                }
                _shells.Clear();
                Environment.Exit(0);
                break;
        }
    }

    private void Start(HostRequest.Start start)
    {
        var id = start.Id;
        if (_shells.TryRemove(id, out var previous))
        {
            previous.Pty.Dispose();
        }
        try
        {
            var pty = PseudoTerminal.Start(new PtyOptions(start.Cmd, start.Cols, start.Rows, start.Cwd, start.Env));
            var shell = new HostedShell(id, pty);
            _shells[id] = shell;
            new Thread(() => Pump(shell)) { IsBackground = true, Name = $"host-pty-{id}" }.Start();
            Send(new HostEvent.Started(id, pty.ProcessId));
        }
        catch (Exception e)
        {
            Send(new HostEvent.Failed(id, e.Message));
        }
    }

    /// <summary>Reads a shell's output into its ring and on to the window, then reports how it ended.</summary>
    private void Pump(HostedShell shell)
    {
        var decoder = Encoding.UTF8.GetDecoder();
        var bytes = new byte[ReadSize];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        try
        {
            int read;
            while ((read = shell.Pty.Output.Read(bytes, 0, bytes.Length)) > 0)
            {
                var count = decoder.GetChars(bytes, 0, read, chars, 0);
                if (count == 0)
                {
                    continue;
                }
                var text = new string(chars, 0, count);
                shell.Output.Add(text);
                Send(new HostEvent.Output(shell.Id, text));
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
        }
        try
        {
            shell.ExitCode = shell.Pty.Exited.GetAwaiter().GetResult();
        }
        catch (OperationCanceledException)
        {
            shell.ExitCode = HostEvent.UnknownExitCode;
        }
        if (_shells.ContainsKey(shell.Id))
        {
            Send(new HostEvent.Exited(shell.Id, shell.ExitCode ?? HostEvent.UnknownExitCode));
        }
        _idleSince = DateTime.UtcNow;
    }

    /// <summary>To the attached window, if there is one; output for no one is only kept in the rings.</summary>
    private void Send(HostEvent message)
    {
        lock (_clientGate)
        {
            if (_client is not { IsConnected: true } client)
            {
                return;
            }
            try
            {
                HostProtocol.Write(client, message);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException)
            {
            }
        }
    }

    /// <summary>Quits once nothing is left to keep: no window attached and no shell running, for a minute.</summary>
    private void IdleWatch()
    {
        while (!_stopping)
        {
            Thread.Sleep(IdleCheck);
            bool attached;
            lock (_clientGate)
            {
                attached = _client is not null;
            }
            if (attached || _shells.Values.Any(s => s.Alive))
            {
                _idleSince = DateTime.UtcNow;
            }
            else if (DateTime.UtcNow - _idleSince > IdleExit)
            {
                Environment.Exit(0);
            }
        }
    }
}
