using System.Net;
using System.Net.Sockets;
using System.Runtime.Versioning;
using Termilly.Desktop.Platform;
using Termilly.Linux;

namespace Termilly.Core.Tests;

/// <summary>The ports a terminal's programs listen on, on Linux, read from this machine's /proc.</summary>
[SupportedOSPlatform("linux")] // the tests themselves return early elsewhere
public sealed class LinuxPortsTests
{
    [Fact]
    public void A_listening_socket_shows_with_its_process()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var found = Assert.Single(LinuxPorts.Listening(), l => l.Port == port);
            Assert.Equal("127.0.0.1", found.Address);
            Assert.Equal(Environment.ProcessId, found.Pid);
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void This_process_belongs_to_the_terminal_whose_shell_it_is()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var owners = ListeningPorts.TerminalOwners(new Dictionary<string, int> { ["tab1"] = Environment.ProcessId }, LinuxPorts.ParentIds());
        Assert.Equal("tab1", owners[Environment.ProcessId]);
    }
}
