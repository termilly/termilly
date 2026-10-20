using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Termilly.Desktop.Platform;

namespace Termilly.Desktop.Tests;

/// <summary>The ports a terminal's programs listen on, for its sidebar row.</summary>
public sealed class PortsTests
{
    [Fact]
    public void A_listening_port_shows_with_its_process()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try
        {
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            var found = Assert.Single(Ports.Listening(), l => l.Port == port);
            Assert.Equal(("127.0.0.1", Environment.ProcessId), (found.Address, found.Pid));
        }
        finally
        {
            listener.Stop();
        }
    }

    [Fact]
    public void A_terminals_shell_and_everything_it_started_belong_to_it()
    {
        // 10 is a terminal's shell; it started 11, which started 12. 20 is the other terminal's shell. 30 is elsewhere.
        var parents = new Dictionary<int, int> { [10] = 1, [11] = 10, [12] = 11, [20] = 1, [21] = 20, [30] = 1, [31] = 30 };
        var owners = ListeningPorts.TerminalOwners(new Dictionary<string, int> { ["t1"] = 10, ["t2"] = 20 }, parents);
        Assert.Equal(new Dictionary<int, string> { [10] = "t1", [11] = "t1", [12] = "t1", [20] = "t2", [21] = "t2" }, owners);
    }

    [Fact]
    public void Processes_started_from_a_terminal_belong_to_it()
    {
        // cmd stands in for a terminal's shell, and ping for what someone runs in it.
        using var shell = Process.Start(new ProcessStartInfo("cmd.exe", "/c ping -n 30 127.0.0.1 >nul") { CreateNoWindow = true, UseShellExecute = false })!;
        try
        {
            int? ping = null;
            for (var i = 0; i < 50 && ping is null; i++)
            {
                Thread.Sleep(100);
                ping = Ports.ParentIds().Where(p => p.Value == shell.Id).Select(p => (int?)p.Key).FirstOrDefault();
            }
            var owners = ListeningPorts.TerminalOwners(new Dictionary<string, int> { ["t1"] = shell.Id }, Ports.ParentIds());
            Assert.Equal("t1", owners[shell.Id]);
            Assert.Equal("t1", owners[ping!.Value]);
            Assert.False(owners.ContainsKey(Environment.ProcessId));
        }
        finally
        {
            shell.Kill(entireProcessTree: true);
        }
    }
}
