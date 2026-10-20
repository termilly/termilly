using System.IO;
using System.Text;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>Pumps one PTY's output to a callback and forwards typed input to it.</summary>
internal sealed class TerminalSession : IShellSession
{
    /// <summary>How much of the pseudo console's output is read at a time.</summary>
    private const int ReadSize = TerminalStreams.ReadSize;

    private readonly IPty _pty;
    private readonly Action<string> _onOutput;
    private readonly Action<int> _onExit;
    private volatile bool _disposed;

    public TerminalSession(IPty pty, Action<string> onOutput, Action<int> onExit)
    {
        _pty = pty;
        _onOutput = onOutput;
        _onExit = onExit;
        new Thread(ReadLoop) { IsBackground = true, Name = $"pty-{pty.ProcessId}" }.Start();
    }

    /// <summary>The process the pseudo console started (the shell, or the profile's command).</summary>
    public int ProcessId => _pty.ProcessId;

    public void Write(string text)
    {
        if (_disposed)
        {
            return;
        }

        try
        {
            var bytes = Encoding.UTF8.GetBytes(text);
            _pty.Input.Write(bytes);
            _pty.Input.Flush();
        }
        catch (IOException)
        {
            // Process is gone; the exit notification follows.
        }
    }

    public void Resize(int columns, int rows)
    {
        if (!_disposed)
        {
            _pty.Resize(columns, rows);
        }
    }

    public void Dispose()
    {
        _disposed = true;
        _pty.Dispose();
    }

    private void ReadLoop()
    {
        var decoder = Encoding.UTF8.GetDecoder();
        var bytes = new byte[ReadSize];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(bytes.Length)];
        try
        {
            int read;
            while ((read = _pty.Output.Read(bytes, 0, bytes.Length)) > 0)
            {
                var count = decoder.GetChars(bytes, 0, read, chars, 0);
                if (count > 0 && !_disposed)
                {
                    _onOutput(new string(chars, 0, count));
                }
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
        }

        if (_disposed)
        {
            return;
        }

        try
        {
            var code = _pty.Exited.GetAwaiter().GetResult();
            if (!_disposed)
            {
                _onExit(code);
            }
        }
        catch (OperationCanceledException)
        {
        }
    }
}
