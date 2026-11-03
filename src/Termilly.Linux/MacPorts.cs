using System.Globalization;
using Termilly.Desktop;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// The TCP ports listened on, on macOS (which has no /proc/net): lsof's field output lists each listening socket
/// under the process holding it. lsof sees this user's processes; that's every process a terminal starts.
/// </summary>
internal sealed class MacPorts(IProcessRunner runner)
{
    private const string Lsof = "lsof";
    /// <summary>
    /// Numbers only (no name lookups, which can take seconds), TCP sockets listening, no warnings (about network
    /// volumes it can't look at), and fields: p for a process, n for a socket's address.
    /// </summary>
    private static readonly string[] Arguments = ["-nP", "-w", "-iTCP", "-sTCP:LISTEN", "-Fpn"];
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);
    private const char ProcessField = 'p';
    private const char AddressField = 'n';

    /// <summary>Every listening TCP socket (IPv4 and IPv6) with its process; nothing when lsof can't be run.</summary>
    public IReadOnlyList<(int Pid, int Port)> Listening()
    {
        try
        {
            return Parse(runner.Run(new ProcessRequest(Lsof, Arguments) { Timeout = Timeout }).Text);
        }
        catch (IOException)
        {
            return [];
        }
    }

    /// <summary>
    /// lsof's field output: a "p&lt;pid&gt;" line, then for each of its sockets an "f&lt;fd&gt;" and an
    /// "n&lt;address&gt;:&lt;port&gt;" line ("*:3000", "127.0.0.1:5432", "[::1]:8080").
    /// </summary>
    internal static List<(int Pid, int Port)> Parse(string output)
    {
        var listening = new List<(int Pid, int Port)>();
        int? pid = null;
        foreach (var line in output.Split('\n', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (line[0] == ProcessField)
            {
                pid = int.TryParse(line.AsSpan(1), NumberStyles.None, CultureInfo.InvariantCulture, out var id) ? id : null;
            }
            else if (line[0] == AddressField && pid is { } owner &&
                     int.TryParse(line.AsSpan(line.LastIndexOf(':') + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var port))
            {
                listening.Add((owner, port));
            }
        }
        return listening;
    }

    /// <summary>Every process's parent.</summary>
    public static IReadOnlyDictionary<int, int> ParentIds() =>
        BusyWatcher.Snapshot().GroupBy(p => p.Id).ToDictionary(g => g.Key, g => g.First().ParentId);
}
