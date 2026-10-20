using System.IO;
using System.IO.Ports;
using System.Threading;

namespace Termilly.Desktop.Tests;

public sealed class SerialTests
{
    [Theory]
    [InlineData("CR", "ls\r", "ls\r")]
    [InlineData("LF", "ls\r", "ls\n")]
    [InlineData("CRLF", "a\rb\r", "a\r\nb\r\n")]
    public void Enter_is_sent_as_the_line_ending_the_device_wants(string ending, string typed, string sent) =>
        Assert.Equal(sent, ByteStreamSession.TranslateEnter(typed, ending));

    [Fact]
    public void Hex_view_shows_offset_bytes_and_printable_text()
    {
        long offset = 0;
        var dump = ByteStreamSession.HexDump("Hello\r\n\u0001AB"u8.ToArray(), ref offset);
        Assert.Equal("00000000  48 65 6C 6C 6F 0D 0A 01 41 42                    |Hello...AB|\r\n", dump);
        Assert.Equal(10, offset);
        Assert.StartsWith("0000000A  ", ByteStreamSession.HexDump([1], ref offset));
    }

    [Fact]
    public void Telnet_commands_are_taken_out_and_options_answered()
    {
        var telnet = new Telnet();
        var replies = new List<byte[]>();
        byte[] input =
        [
            (byte)'o', (byte)'k',
            Telnet.IAC, Telnet.DO, 3,              // DO suppress-go-ahead → WILL
            Telnet.IAC, Telnet.DO, 24,             // DO terminal type → WONT
            Telnet.IAC, Telnet.WILL, 1,            // WILL echo → DO
            Telnet.IAC, Telnet.SB, 24, 1, Telnet.IAC, Telnet.SE, // a subnegotiation: skipped
            Telnet.IAC, Telnet.IAC,                // an escaped 0xFF in the data
            (byte)'!',
        ];

        var data = telnet.Filter(input, replies.Add);

        Assert.Equal([(byte)'o', (byte)'k', 0xFF, (byte)'!'], data);
        Assert.Equal([[Telnet.IAC, Telnet.WILL, 3], [Telnet.IAC, Telnet.WONT, 24], [Telnet.IAC, Telnet.DO, 1]], replies);
    }

    [Fact]
    public void Telnet_commands_split_across_reads_still_parse()
    {
        var telnet = new Telnet();
        var replies = new List<byte[]>();
        Assert.Equal([(byte)'a'], telnet.Filter([(byte)'a', Telnet.IAC], replies.Add));
        Assert.Equal([(byte)'b'], telnet.Filter([Telnet.DO, 0, (byte)'b'], replies.Add));
        Assert.Equal([Telnet.IAC, Telnet.WILL, 0], Assert.Single(replies));
    }

    [Fact]
    public void Data_0xFF_is_doubled_and_RFC2217_sets_the_line_speed()
    {
        Assert.Equal([1, 0xFF, 0xFF, 2], Telnet.Escape([1, 0xFF, 2]));
        Assert.Equal([Telnet.IAC, Telnet.WILL, 44, Telnet.IAC, Telnet.SB, 44, 1, 0, 1, 0xC2, 0x00, Telnet.IAC, Telnet.SE], Telnet.SetBaud(115200));
    }

    [Fact]
    public void Ports_and_network_consoles_become_profiles()
    {
        var settings = new AppSettings { Shells = new() { SerialPorts = [new SerialSettings("COM5", 9600, Parity: "even", Flow: "rts/cts")], NetworkConsoles = [new NetworkConsole("n1", "switch-a", "10.0.0.20", 2001, "telnet")] } }.Normalize();

        var profiles = SessionProfiles.SerialProfiles(settings, [("COM5", "USB Serial Port (COM5)"), ("COM1", "COM1")]).ToList();

        Assert.Equal(["serial-com5", "serial-com1", "netcon-n1"], profiles.Select(p => p.Id));
        Assert.Equal("USB Serial Port · 9600 8E1 · rts/cts", profiles[0].Description);
        Assert.Equal("115200 8N1", profiles[1].Description);
        Assert.Equal(("net:n1", "10.0.0.20:2001 · Telnet"), (profiles[2].CommandLine, profiles[2].Description));
    }

    [Fact]
    public void A_cancelled_read_reconnects_instead_of_ending_the_app()
    {
        var opens = 0;
        using var reopened = new ManualResetEventSlim();
        (Stream, SerialPort?, string) Open()
        {
            if (Interlocked.Increment(ref opens) > 1)
            {
                reopened.Set();
            }
            return (new CancelledStream(), null, "open");
        }

        using (new ByteStreamSession("test", Open, telnet: false, LineEndings.Cr, log: false, _ => { }))
        {
            Assert.True(reopened.Wait(TimeSpan.FromSeconds(10)));
        }
    }

    /// <summary>A stream whose reads are cancelled, as a COM port's are when it's closed under them.</summary>
    private sealed class CancelledStream : MemoryStream
    {
        public override int Read(byte[] buffer, int offset, int count) => throw new OperationCanceledException();
    }

    [Fact]
    public void Odd_serial_settings_fall_back_to_safe_ones()
    {
        var s = SerialPorts.Normalize(new SerialSettings("COM3", 7, 9, "weird", "3", "magic", "NL"));
        Assert.Equal((115200, 8, "none", "1", "none", "CR"), (s.Baud, s.DataBits, s.Parity, s.StopBits, s.Flow, s.LineEnding));
    }
}
