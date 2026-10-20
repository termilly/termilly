using System.IO;
using System.IO.Ports;
using System.Net.Sockets;
using System.Text;
using Microsoft.Win32;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A COM port's settings (Settings › Serial, js/serial.js): the values each can take.</summary>
internal static class SerialOptions
{
    public const int DefaultBaud = 115200;
    public const int MinBaud = 50;
    public const int MaxBaud = 4_000_000;
    public const int DefaultDataBits = 8;
    public const int MinDataBits = 5;

    public static class Parity
    {
        public const string None = "none";
        public const string Even = "even";
        public const string Odd = "odd";
        public const string Mark = "mark";
        public const string Space = "space";
        public static readonly IReadOnlyList<string> All = [None, Even, Odd, Mark, Space];
    }

    public static class StopBits
    {
        public const string One = "1";
        public const string OnePointFive = "1.5";
        public const string Two = "2";
        public static readonly IReadOnlyList<string> All = [One, OnePointFive, Two];
    }

    /// <summary>Flow control: none, hardware (RTS/CTS) or software (XON/XOFF).</summary>
    public static class Flow
    {
        public const string None = "none";
        public const string RtsCts = "rts/cts";
        public const string XonXoff = "xon/xoff";
        public static readonly IReadOnlyList<string> All = [None, RtsCts, XonXoff];
    }
}

/// <summary>What Enter sends to a serial or network device.</summary>
internal static class LineEndings
{
    public const string Cr = "CR";
    public const string Lf = "LF";
    public const string CrLf = "CRLF";
    public const string Default = Cr;
    public static readonly IReadOnlyList<string> All = [Cr, Lf, CrLf];

    /// <summary>The line ending when it's a known one, else <see cref="Default"/>.</summary>
    public static string OrDefault(string? lineEnding) => lineEnding is { } known && All.Contains(known) ? known : Default;
}

/// <summary>How a network console is reached: raw TCP, or Telnet (with RFC 2217 COM port control).</summary>
internal static class NetworkProtocols
{
    public const string Raw = "raw";
    public const string Telnet = "telnet";
    public const string Default = Raw;

    /// <summary>How a terminal's description names it.</summary>
    public static string Describe(string protocol) => protocol == Telnet ? "Telnet" : "raw TCP";
}

/// <summary>How a COM port is set up (Settings › Serial); one per port that's been changed from the defaults.</summary>
internal sealed record SerialSettings(
    string Port,
    int Baud = SerialOptions.DefaultBaud,
    int DataBits = SerialOptions.DefaultDataBits,
    string Parity = SerialOptions.Parity.None,
    string StopBits = SerialOptions.StopBits.One,
    string Flow = SerialOptions.Flow.None,
    string LineEnding = LineEndings.Default,
    bool Log = false);

/// <summary>A console server or device reached over the network: raw TCP, or Telnet with RFC 2217 COM port control.</summary>
internal sealed record NetworkConsole(
    string Id,
    string Name,
    string Host,
    int Port,
    string Protocol = NetworkProtocols.Default,
    int? Baud = null,
    string LineEnding = LineEndings.Default,
    bool Log = false,
    IReadOnlyList<string>? Tags = null);

/// <summary>COM ports on this PC, with the names Device Manager shows ("USB Serial Port (COM5)").</summary>
internal static class SerialPorts
{
    /// <summary>Windows' COM port names: COM1, COM2...</summary>
    public const string ComPrefix = "COM";

    public static IReadOnlyList<(string Port, string FriendlyName)> Detect()
    {
        var names = FriendlyNames();
        return SerialPort.GetPortNames()
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(p => int.TryParse(p.AsSpan(ComPrefix.Length), out var n) ? n : int.MaxValue)
            .Select(p => (p, names.TryGetValue(p, out var name) ? name : p))
            .ToList();
    }

    /// <summary>COM port → its device's friendly name, from the registry's device list (no WMI needed).</summary>
    private static Dictionary<string, string> FriendlyNames()
    {
        var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!OperatingSystem.IsWindows())
        {
            return names; // device names come from the registry
        }
        try
        {
            using var enumRoot = Registry.LocalMachine.OpenSubKey(@"SYSTEM\CurrentControlSet\Enum");
            foreach (var bus in enumRoot?.GetSubKeyNames() ?? [])
            {
                using var busKey = enumRoot!.OpenSubKey(bus);
                foreach (var device in busKey?.GetSubKeyNames() ?? [])
                {
                    using var deviceKey = busKey!.OpenSubKey(device);
                    foreach (var instance in deviceKey?.GetSubKeyNames() ?? [])
                    {
                        using var instanceKey = deviceKey!.OpenSubKey(instance);
                        using var parameters = instanceKey?.OpenSubKey("Device Parameters");
                        if (parameters?.GetValue("PortName") is string port && port.StartsWith(ComPrefix, StringComparison.OrdinalIgnoreCase) &&
                            instanceKey!.GetValue("FriendlyName") is string friendly)
                        {
                            names[port] = friendly;
                        }
                    }
                }
            }
        }
        catch (Exception e) when (e is System.Security.SecurityException or UnauthorizedAccessException or IOException)
        {
            // Plain COM names then.
        }
        return names;
    }

    public static string Describe(SerialSettings s) =>
        $"{s.Baud} {s.DataBits}{char.ToUpperInvariant(s.Parity[0])}{s.StopBits}{(s.Flow == SerialOptions.Flow.None ? "" : $" · {s.Flow}")}";

    public static SerialPort Open(SerialSettings s)
    {
        var port = new SerialPort(s.Port, s.Baud, s.Parity switch
        {
            SerialOptions.Parity.Even => System.IO.Ports.Parity.Even,
            SerialOptions.Parity.Odd => System.IO.Ports.Parity.Odd,
            SerialOptions.Parity.Mark => System.IO.Ports.Parity.Mark,
            SerialOptions.Parity.Space => System.IO.Ports.Parity.Space,
            _ => System.IO.Ports.Parity.None,
        }, s.DataBits, s.StopBits switch
        {
            SerialOptions.StopBits.OnePointFive => System.IO.Ports.StopBits.OnePointFive,
            SerialOptions.StopBits.Two => System.IO.Ports.StopBits.Two,
            _ => System.IO.Ports.StopBits.One,
        })
        {
            Handshake = s.Flow switch
            {
                SerialOptions.Flow.RtsCts => Handshake.RequestToSend,
                SerialOptions.Flow.XonXoff => Handshake.XOnXOff,
                _ => Handshake.None,
            },
            DtrEnable = true,
            ReadTimeout = SerialPort.InfiniteTimeout,
        };
        port.Open();
        return port;
    }

    public static SerialSettings Normalize(SerialSettings s) => s with
    {
        Baud = s.Baud is >= SerialOptions.MinBaud and <= SerialOptions.MaxBaud ? s.Baud : SerialOptions.DefaultBaud,
        DataBits = s.DataBits is >= SerialOptions.MinDataBits and <= SerialOptions.DefaultDataBits ? s.DataBits : SerialOptions.DefaultDataBits,
        Parity = SerialOptions.Parity.All.Contains(s.Parity) ? s.Parity : SerialOptions.Parity.None,
        StopBits = SerialOptions.StopBits.All.Contains(s.StopBits) ? s.StopBits : SerialOptions.StopBits.One,
        Flow = SerialOptions.Flow.All.Contains(s.Flow) ? s.Flow : SerialOptions.Flow.None,
        LineEnding = LineEndings.OrDefault(s.LineEnding),
    };

    /// <summary>A network console with a known protocol and line ending.</summary>
    public static NetworkConsole Normalize(NetworkConsole c) => c with
    {
        Protocol = c.Protocol == NetworkProtocols.Telnet ? NetworkProtocols.Telnet : NetworkProtocols.Raw,
        LineEnding = LineEndings.OrDefault(c.LineEnding),
    };
}

/// <summary>
/// A terminal on a byte stream instead of a pseudo console: a COM port, or a TCP connection to a console server.
/// Enter is sent as the line ending the device wants; output can be shown as a hex dump; lines can be logged with
/// timestamps; a dropped connection (an unplugged USB adapter, a closed socket) is retried until it's back.
/// </summary>
internal sealed class ByteStreamSession : IShellSession
{
    private static readonly TimeSpan Retry = TimeSpan.FromSeconds(2);
    private static readonly TimeSpan BreakLength = TimeSpan.FromMilliseconds(300);
    private const int ReadSize = 4096;

    private readonly string _name;
    private readonly Func<(Stream Stream, SerialPort? Port, string Banner)> _open;
    private readonly bool _telnet;
    private readonly Action<string> _onOutput;
    private readonly Telnet _telnetState = new();
    private readonly Lock _gate = new();
    private Stream? _stream;
    private SerialPort? _port;
    private readonly StreamWriter? _log;
    private string _lineStart = "";
    private long _hexOffset;
    private volatile bool _disposed;

    public ByteStreamSession(string name, Func<(Stream, SerialPort?, string)> open, bool telnet, string lineEnding, bool log, Action<string> onOutput)
    {
        _name = name;
        _open = open;
        _telnet = telnet;
        LineEnding = lineEnding;
        _onOutput = onOutput;
        if (log)
        {
            var dir = AppPaths.LogsFolder;
            Directory.CreateDirectory(dir);
            var file = Path.Combine(dir, $"{string.Concat(name.Split(Path.GetInvalidFileNameChars()))}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
            _log = new StreamWriter(file, append: true, Encoding.UTF8) { AutoFlush = true };
            Status($"logging to {file}");
        }
        new Thread(ReadLoop) { IsBackground = true, Name = $"stream-{name}" }.Start();
    }

    public int ProcessId => 0;

    /// <summary>What Enter sends: CR, LF or CRLF.</summary>
    public string LineEnding { get; set; }

    /// <summary>Shows what arrives as a hex dump instead of text.</summary>
    public bool Hex { get; set; }

    public void Write(string text)
    {
        var bytes = Encoding.UTF8.GetBytes(TranslateEnter(text, LineEnding));
        if (_telnet)
        {
            bytes = Telnet.Escape(bytes);
        }
        lock (_gate)
        {
            try
            {
                _stream?.Write(bytes);
                _stream?.Flush();
            }
            catch (Exception e) when (e is IOException or InvalidOperationException or ObjectDisposedException or TimeoutException)
            {
                // The read loop notices and reconnects.
            }
        }
    }

    /// <summary>Enter arrives from the terminal as CR; devices may want LF or CRLF instead.</summary>
    public static string TranslateEnter(string text, string lineEnding) => lineEnding switch
    {
        LineEndings.Lf => text.Replace('\r', '\n'),
        LineEndings.CrLf => text.Replace("\r", "\r\n"),
        _ => text,
    };

    public void Resize(int columns, int rows)
    {
    }

    /// <summary>A serial Break (line held low for 300 ms), or Telnet's BRK.</summary>
    public void SendBreak()
    {
        lock (_gate)
        {
            try
            {
                if (_port is { IsOpen: true } port)
                {
                    port.BreakState = true;
                    Thread.Sleep(BreakLength);
                    port.BreakState = false;
                }
                else if (_telnet)
                {
                    _stream?.Write([Telnet.IAC, Telnet.BRK]);
                }
            }
            catch (Exception e) when (e is IOException or InvalidOperationException)
            {
            }
        }
        Status("break sent");
    }

    /// <summary>Connects, shows what arrives until the connection drops, and tries again until disposed.</summary>
    private void ReadLoop()
    {
        var decoder = Encoding.UTF8.GetDecoder();
        var buffer = new byte[ReadSize];
        var chars = new char[Encoding.UTF8.GetMaxCharCount(buffer.Length)];
        while (!_disposed)
        {
            try
            {
                var (stream, port, banner) = _open();
                lock (_gate)
                {
                    _stream = stream;
                    _port = port;
                }
                Status(banner);
                int read;
                while (!_disposed && (read = stream.Read(buffer, 0, buffer.Length)) > 0)
                {
                    Show(stream, buffer.AsSpan(0, read), decoder, chars);
                }
                if (!_disposed)
                {
                    Status("connection closed, trying again…");
                }
            }
            // A port closed under a blocked read (the terminal closing, or the driver giving up) ends that read with
            // OperationCanceledException or ObjectDisposedException. This is its own thread, so anything let through
            // here would end the app.
            catch (Exception e) when (Storage.IsFileError(e) || e is InvalidOperationException or SocketException or ArgumentException or TimeoutException or OperationCanceledException or ObjectDisposedException)
            {
                if (!_disposed)
                {
                    Status($"{e.Message.TrimEnd('.')} - trying again every {Retry.TotalSeconds:0} s");
                }
            }
            finally
            {
                Close();
            }
            if (!_disposed)
            {
                Thread.Sleep(Retry);
            }
        }
    }

    /// <summary>Bytes from the device, as text or a hex dump, and to the log (Telnet's own commands answered and left out).</summary>
    private void Show(Stream stream, ReadOnlySpan<byte> received, Decoder decoder, char[] chars)
    {
        var data = _telnet ? _telnetState.Filter(received, reply => { lock (_gate) { stream.Write(reply); } }) : received.ToArray();
        if (data.Length == 0)
        {
            return;
        }
        if (Hex)
        {
            _onOutput(HexDump(data, ref _hexOffset));
        }
        var count = decoder.GetChars(data, 0, data.Length, chars, 0);
        var text = new string(chars, 0, count);
        if (!Hex)
        {
            _onOutput(text);
        }
        WriteLog(text);
    }

    private void Close()
    {
        lock (_gate)
        {
            try
            {
                _port?.Close();
                _stream?.Dispose();
            }
            catch (IOException)
            {
            }
            _stream = null;
            _port = null;
        }
    }

    /// <summary>A message from Termilly in the terminal, dimmed so it isn't mistaken for the device's output.</summary>
    private void Status(string message) => _onOutput($"\r\n\x1b[2m[{_name}: {message}]\x1b[0m\r\n");

    /// <summary>Each line goes to the log with the time its first character arrived.</summary>
    private void WriteLog(string text)
    {
        if (_log is null)
        {
            return;
        }
        foreach (var ch in text)
        {
            if (_lineStart.Length == 0)
            {
                _log.Write($"[{DateTime.Now:HH:mm:ss.fff}] ");
                _lineStart = "x";
            }
            if (ch == '\n')
            {
                _log.Write('\n');
                _lineStart = "";
            }
            else if (ch != '\r')
            {
                _log.Write(ch);
            }
        }
    }

    /// <summary>A hex dump's bytes a line.</summary>
    private const int HexLine = 16;

    /// <summary>16 bytes a line: offset, hex, and the printable characters.</summary>
    public static string HexDump(byte[] data, ref long offset)
    {
        var text = new StringBuilder();
        for (var i = 0; i < data.Length; i += HexLine)
        {
            var row = data.AsSpan(i, Math.Min(HexLine, data.Length - i));
            text.Append(System.Globalization.CultureInfo.InvariantCulture, $"{offset + i:X8}  ");
            for (var j = 0; j < HexLine; j++)
            {
                text.Append(j < row.Length ? $"{row[j]:X2} " : "   ");
            }
            text.Append(" |");
            foreach (var b in row)
            {
                text.Append(b is >= (byte)' ' and <= (byte)'~' ? (char)b : '.');
            }
            text.Append("|\r\n");
        }
        offset += data.Length;
        return text.ToString();
    }

    public void Dispose()
    {
        _disposed = true;
        lock (_gate)
        {
            try
            {
                _port?.Close();
                _stream?.Dispose();
            }
            catch (IOException)
            {
            }
        }
        _log?.Dispose();
    }

    // ---- Opening ----

    public static ByteStreamSession ForSerial(SerialSettings s, string name, Action<string> onOutput) =>
        new(name, () =>
        {
            var port = SerialPorts.Open(s);
            return (port.BaseStream, port, $"{s.Port} open at {SerialPorts.Describe(s)} · Enter sends {s.LineEnding}");
        }, telnet: false, s.LineEnding, s.Log, onOutput);

    public static ByteStreamSession ForNetwork(NetworkConsole c, Action<string> onOutput) =>
        new(c.Name, () =>
        {
            var client = new TcpClient { NoDelay = true };
            client.Connect(c.Host, c.Port);
            var stream = client.GetStream();
            if (c.Protocol == NetworkProtocols.Telnet && c.Baud is { } baud)
            {
                stream.Write(Telnet.SetBaud(baud)); // RFC 2217: ask the console server to set the line speed
            }
            return (stream, null, $"connected to {c.Host}:{c.Port} ({NetworkProtocols.Describe(c.Protocol)})");
        }, c.Protocol == NetworkProtocols.Telnet, c.LineEnding, c.Log, onOutput);
}

/// <summary>
/// Just enough Telnet for console servers: commands are taken out of the data, options are answered (only
/// binary, suppress-go-ahead, echo and RFC 2217's COM port control are accepted), and 0xFF in data is doubled.
/// </summary>
internal sealed class Telnet
{
    public const byte IAC = 255, DONT = 254, DO = 253, WONT = 252, WILL = 251, SB = 250, SE = 240, BRK = 243;
    private const byte Binary = 0, Echo = 1, SuppressGoAhead = 3, ComPort = 44;

    /// <summary>RFC 2217's SET-BAUDRATE command, and its value's size.</summary>
    private const byte SetBaudRate = 1;
    private const int BaudBytes = 4;

    /// <summary>Where the reader is: in data, after IAC, after an option verb, in a subnegotiation, or after IAC in one.</summary>
    private enum State { Data, Command, Option, Sub, SubCommand }

    private State _state;
    private byte _verb;

    /// <summary>The data bytes of a chunk; option answers go out through <paramref name="reply"/>.</summary>
    public byte[] Filter(ReadOnlySpan<byte> input, Action<byte[]> reply)
    {
        var data = new List<byte>(input.Length);
        foreach (var b in input)
        {
            switch (_state)
            {
                case State.Data when b == IAC:
                    _state = State.Command;
                    break;
                case State.Data:
                    data.Add(b);
                    break;
                case State.Command when b == IAC:
                    data.Add(IAC);
                    _state = State.Data;
                    break;
                case State.Command when b is DO or DONT or WILL or WONT:
                    _verb = b;
                    _state = State.Option;
                    break;
                case State.Command when b == SB:
                    _state = State.Sub;
                    break;
                case State.Command:
                    _state = State.Data; // a command without an option (NOP, GA…)
                    break;
                case State.Option:
                    var accepted = b is Binary or SuppressGoAhead or ComPort || (_verb == WILL && b == Echo);
                    if (_verb == DO)
                    {
                        reply([IAC, accepted ? WILL : WONT, b]);
                    }
                    else if (_verb == WILL)
                    {
                        reply([IAC, accepted ? DO : DONT, b]);
                    }
                    _state = State.Data;
                    break;
                case State.Sub when b == IAC:
                    _state = State.SubCommand;
                    break;
                case State.Sub:
                    break;
                case State.SubCommand:
                    _state = b == SE ? State.Data : State.Sub;
                    break;
            }
        }
        return [.. data];
    }

    public static byte[] Escape(byte[] data) => data.Contains(IAC) ? data.SelectMany(b => b == IAC ? new[] { IAC, IAC } : [b]).ToArray() : data;

    /// <summary>RFC 2217 SET-BAUDRATE: IAC SB COM-PORT-OPTION 1 &lt;baud, 4 bytes big-endian&gt; IAC SE.</summary>
    public static byte[] SetBaud(int baud)
    {
        var value = new byte[BaudBytes];
        System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(value, baud);
        return [IAC, WILL, ComPort, IAC, SB, ComPort, SetBaudRate, .. value, IAC, SE];
    }
}
