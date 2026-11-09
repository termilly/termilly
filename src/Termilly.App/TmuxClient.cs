using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>A command line split into the program and its arguments.</summary>
internal readonly record struct CommandParts(string File, string Arguments);

/// <summary>
/// tmux in control mode (<c>tmux -C</c>), for a server's tmux shown as Termilly terminals (js/tmux.js): a process on
/// plain pipes, not a pseudo console, which would redraw tmux's protocol lines as a screen. Its output goes to the
/// page as it comes; the page writes tmux commands to it (send-keys, refresh-client…).
/// <c>wsl tmux -C new -A -s main</c> attaches to WSL's tmux; <c>ssh -T host tmux -C new -A -s main</c> to a server's.
/// </summary>
internal sealed class TmuxClient : IDisposable
{
    /// <summary>How much of tmux's control-mode output is read at a time.</summary>
    private const int ReadSize = TerminalStreams.ReadSize;

    private readonly Process _process;
    private readonly StreamWriter _input;

    private TmuxClient(Process process)
    {
        _process = process;
        _input = new StreamWriter(process.StandardInput.BaseStream, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };
    }

    /// <summary>Starts the command (program and arguments, as typed); output and exit go to the callbacks.</summary>
    public static TmuxClient Start(string commandLine, Action<string> output, Action<int> exited)
    {
        var (file, arguments) = Split(commandLine);
        var start = new ProcessStartInfo(file, arguments)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        var process = Process.Start(start) ?? throw new IOException($"{file} didn't start.");
        var client = new TmuxClient(process);
        new Thread(() => Pump(process.StandardOutput, output)) { IsBackground = true, Name = "tmux-out" }.Start();
        new Thread(() => Pump(process.StandardError, text => output($"%termilly-stderr {text.Replace('\n', ' ')}\n"))) { IsBackground = true, Name = "tmux-err" }.Start();
        process.EnableRaisingEvents = true;
        process.Exited += (_, _) => exited(process.ExitCode);
        return client;
    }

    private static void Pump(StreamReader reader, Action<string> output)
    {
        var buffer = new char[ReadSize];
        try
        {
            int read;
            while ((read = reader.Read(buffer, 0, buffer.Length)) > 0)
            {
                output(new string(buffer, 0, read));
            }
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // The process ended.
        }
    }

    /// <summary>The program and its arguments from a command line: the first word (quotes allowed), then the rest.</summary>
    internal static CommandParts Split(string commandLine)
    {
        var text = commandLine.Trim();
        if (text.StartsWith('"'))
        {
            var close = text.IndexOf('"', 1);
            return close < 0 ? new(text.Trim('"'), "") : new(text[1..close], text[(close + 1)..].Trim());
        }
        var space = text.IndexOf(' ');
        return space < 0 ? new(text, "") : new(text[..space], text[(space + 1)..].Trim());
    }

    /// <summary>Sends tmux commands, one per line.</summary>
    public void Write(string text)
    {
        try
        {
            _input.Write(text.EndsWith('\n') ? text : text + "\n");
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            // Gone; its exit reports it.
        }
    }

    public void Dispose()
    {
        try
        {
            if (!_process.HasExited)
            {
                _process.Kill(entireProcessTree: true);
            }
        }
        catch (Exception e) when (e is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // Already gone.
        }
        _process.Dispose();
    }
}

/// <summary>The tmux clients this window has, by the page's id for each.</summary>
internal sealed class TmuxClients
{
    private readonly ConcurrentDictionary<string, TmuxClient> _clients = new();

    /// <summary>What the page starts when it doesn't say: tmux's session "main", made if it isn't there.</summary>
    public const string DefaultCommand = "tmux -C new -A -s main";

    /// <summary>The exit code reported when tmux couldn't start at all.</summary>
    public const int FailedCode = -1;

    /// <param name="output">What tmux writes, as it comes.</param>
    /// <param name="exited">tmux ended, with its exit code.</param>
    /// <param name="failed">tmux couldn't start: why, in words for the page.</param>
    public void Start(string id, string command, Action<string> output, Action<int> exited, Action<string> failed)
    {
        Stop(id);
        try
        {
            _clients[id] = TmuxClient.Start(command, output, code =>
            {
                _clients.TryRemove(id, out _);
                exited(code);
            });
        }
        catch (Exception e) when (e is IOException or System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // Not found is 2 on both systems (ERROR_FILE_NOT_FOUND, ENOENT): name the program rather than .NET's text.
            var error = e is System.ComponentModel.Win32Exception { NativeErrorCode: 2 }
                ? $"{command.Trim().Split(' ')[0]} isn’t installed here (or isn’t on the PATH)."
                : e.Message;
            failed(error);
        }
    }

    public void Write(string id, string text)
    {
        if (_clients.TryGetValue(id, out var client))
        {
            client.Write(text);
        }
    }

    public void Stop(string id)
    {
        if (_clients.TryRemove(id, out var client))
        {
            client.Dispose();
        }
    }

    /// <summary>Ends every client (the page reloaded or the window closes): tmux itself keeps running there.</summary>
    public void StopAll()
    {
        foreach (var id in _clients.Keys.ToList())
        {
            Stop(id);
        }
    }
}
