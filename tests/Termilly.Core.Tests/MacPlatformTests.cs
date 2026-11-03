using System.Net;
using System.Net.Sockets;
using System.Runtime.Versioning;
using System.Xml.Linq;
using Termilly.Desktop.Services;
using Termilly.Linux;

namespace Termilly.Core.Tests;

/// <summary>What macOS does for the shared code: listening ports from lsof, fonts from CoreText, the launch agent.</summary>
[SupportedOSPlatform("macos")] // the live tests return early elsewhere; the rest only parse text
public sealed class MacPlatformTests
{
    [Fact]
    public void Lsof_lists_each_socket_under_its_process()
    {
        const string output = "p100\nf4\nn*:3000\nf5\nn[::1]:8080\np200\nf7\nn127.0.0.1:5432\n";
        Assert.Equal([(100, 3000), (100, 8080), (200, 5432)], MacPorts.Parse(output));
    }

    [Fact]
    public void Lines_lsof_did_not_finish_are_skipped() =>
        Assert.Equal([(7, 22)], MacPorts.Parse("n*:9\np7\nf3\nn*:22\npx\nn*:80\n"));

    [Fact]
    public void A_listening_socket_shows_with_its_process()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            Assert.Contains((Environment.ProcessId, port), new MacPorts(new ProcessRunner()).Listening());
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void The_fonts_have_the_systems_monospace_ones_with_bold()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }
        var fonts = new MacFonts().Read();
        Assert.Contains("Helvetica", fonts.All);
        Assert.Contains("Menlo", fonts.Monospace);
        Assert.Contains("Menlo", fonts.RealBold);
        Assert.DoesNotContain("Helvetica", fonts.Monospace);
        Assert.DoesNotContain(fonts.All, name => name.StartsWith('.'));
    }

    [Fact]
    public void The_launch_agent_starts_the_host_at_sign_in()
    {
        var plist = XDocument.Parse(MacPlatform.LaunchAgent("/Applications/Termilly & Co/host/termilly-host"));
        var values = plist.Root!.Element("dict")!.Elements().ToList();
        string After(string key) => values[values.FindIndex(e => e.Value == key) + 1].Value;
        Assert.Equal("com.termilly.host", After("Label"));
        Assert.Equal("/Applications/Termilly & Co/host/termilly-host", After("ProgramArguments"));
        Assert.Equal("true", values[values.FindIndex(e => e.Value == "RunAtLoad") + 1].Name.LocalName);
    }
}
