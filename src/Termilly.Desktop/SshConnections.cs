using System.IO;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>
/// An SSH connection defined in Termilly: host, user, port and jump hosts, and how to sign in, as a reference
/// only. Termilly never stores a secret: "agent" uses ssh-agent (or ssh's defaults), "key" and "sk" a key file (sk:
/// a FIDO2 security key), "wincred" a password kept in Windows Credential Manager under <see cref="CredentialTarget"/>,
/// and "op" a 1Password reference (op://vault/item/field) read with the 1Password CLI.
/// </summary>
internal sealed record SshConnection(
    string Id,
    string Name,
    string Host,
    string? User = null,
    int? Port = null,
    string? Jump = null,
    string Identity = SshIdentities.Agent,
    string? KeyPath = null,
    string? SecretRef = null,
    IReadOnlyList<string>? Tags = null)
{
    /// <summary>Where a "wincred" connection's password is kept in Windows Credential Manager.</summary>
    public string CredentialTarget => $"Termilly/ssh/{Id}";
}

/// <summary>
/// A port forward through an SSH connection or ~/.ssh/config host (Target: its profile id). Kind L forwards a
/// local port to Dest, R a remote port back to Dest, D runs a SOCKS proxy on the local port.
/// </summary>
internal sealed record PortForward(
    string Id,
    string Name,
    string Target,
    string Kind = ForwardKinds.Local,
    int ListenPort = SshConnections.DefaultListenPort,
    string? DestHost = SshConnections.LocalHost,
    int? DestPort = null,
    bool AutoStart = false);

/// <summary>A port forward's kind, as ssh's own options name them.</summary>
internal static class ForwardKinds
{
    /// <summary>A local port to a destination (-L).</summary>
    public const string Local = "L";
    /// <summary>A remote port back to a destination (-R).</summary>
    public const string Remote = "R";
    /// <summary>A SOCKS proxy on a local port (-D).</summary>
    public const string Dynamic = "D";
    public static readonly IReadOnlyList<string> All = [Local, Remote, Dynamic];
}

internal static partial class SshConnections
{
    /// <summary>The OpenSSH programs Termilly runs.</summary>
    public const string SshProgram = "ssh";
    public const string SftpProgram = "sftp";
    /// <summary>Where Windows keeps its OpenSSH client, under the system folder.</summary>
    private const string WindowsOpenSshFolder = "OpenSSH";
    public const int DefaultPort = 22;
    public const int MaxPort = 65535;
    public const int DefaultListenPort = 8080;
    public const string LocalHost = "localhost";
    private const int MaxConnections = 100;
    private const int MaxForwards = 50;
    /// <summary>How a 1Password reference starts.</summary>
    private const string OnePasswordScheme = "op://";

    /// <summary>Windows' own OpenSSH program when it has one (ssh.exe, sftp.exe), else whichever is on PATH (Git's on Windows).</summary>
    public static string OpenSshProgram(string name)
    {
        var windows = Path.Combine(Environment.SystemDirectory, WindowsOpenSshFolder, AppPaths.Exe(name));
        return File.Exists(windows) ? windows : AppPaths.Exe(name);
    }

    /// <summary>Hosts, users and jump lists ssh takes on a command line as is (IPv6 in brackets included).</summary>
    [GeneratedRegex(@"^[A-Za-z0-9._@:\-\[\],%]+$")]
    private static partial Regex SafeArgument();

    public static bool IsSafe(string? value) => value is null || SafeArgument().IsMatch(value);

    /// <summary>
    /// The ssh arguments for a connection, quoted for a Windows command line: port, jump hosts, key and the
    /// destination. Unsafe values (spaces, quotes, shell characters) are refused by <see cref="Normalize"/> first.
    /// </summary>
    public static string Arguments(SshConnection c)
    {
        var args = new List<string>();
        if (c.Port is { } port and not DefaultPort)
        {
            args.Add($"-p {port}");
        }
        if (!string.IsNullOrEmpty(c.Jump))
        {
            args.Add($"-J {c.Jump}");
        }
        if (SshIdentities.UsesKeyFile(c.Identity) && !string.IsNullOrEmpty(c.KeyPath))
        {
            args.Add($"-i \"{c.KeyPath}\" -o IdentitiesOnly=yes");
        }
        if (SshIdentities.UsesPassword(c.Identity))
        {
            // The password comes from the reference through SSH_ASKPASS (see Environment).
            args.Add("-o PreferredAuthentications=keyboard-interactive,password,publickey");
        }
        args.Add(string.IsNullOrEmpty(c.User) ? c.Host : $"{c.User}@{c.Host}");
        return string.Join(' ', args);
    }

    /// <summary>
    /// Variables a connection's ssh needs: for a password reference, Termilly's askpass helper (agent\
    /// termilly-askpass.exe) reads it when ssh asks, so the password is never typed, shown or stored by Termilly.
    /// </summary>
    public static Dictionary<string, string>? EnvironmentFor(SshConnection c, string agentDirectory) => c.Identity switch
    {
        SshIdentities.SavedPassword => Askpass(agentDirectory, CredentialReference.For(SshIdentities.SavedPassword, c.CredentialTarget)),
        SshIdentities.OnePassword when !string.IsNullOrEmpty(c.SecretRef) => Askpass(agentDirectory, CredentialReference.For(SshIdentities.OnePassword, c.SecretRef)),
        _ => null,
    };

    private static Dictionary<string, string> Askpass(string agentDirectory, string reference) => new()
    {
        ["SSH_ASKPASS"] = Path.Combine(agentDirectory, AppPaths.Exe(AgentExecutables.Askpass)),
        ["SSH_ASKPASS_REQUIRE"] = "force",
        [TerminalEnvironment.Credential] = reference,
    };

    /// <summary>"user@host:2222 via bastion": what the menu shows under a connection's name.</summary>
    public static string Describe(SshConnection c) =>
        $"{(string.IsNullOrEmpty(c.User) ? "" : c.User + "@")}{c.Host}{(c.Port is { } p and not DefaultPort ? $":{p}" : "")}{(string.IsNullOrEmpty(c.Jump) ? "" : $" via {c.Jump}")}";

    /// <summary>
    /// Arguments for a forward (-N: no shell), on its own or through a connection's or alias's arguments. Ports
    /// listen on 127.0.0.1 only. ExitOnForwardFailure makes a busy port fail at once instead of later.
    /// </summary>
    public static string ForwardArguments(PortForward f, string destinationArguments, bool batch)
    {
        var spec = f.Kind switch
        {
            ForwardKinds.Dynamic => $"-D 127.0.0.1:{f.ListenPort}",
            ForwardKinds.Remote => $"-R {f.ListenPort}:{f.DestHost ?? LocalHost}:{f.DestPort}",
            _ => $"-L 127.0.0.1:{f.ListenPort}:{f.DestHost ?? LocalHost}:{f.DestPort}",
        };
        var options = "-N -o ExitOnForwardFailure=yes -o ServerAliveInterval=30" + (batch ? " -o BatchMode=yes" : "");
        return $"{options} {spec} {destinationArguments}";
    }

    public static string DescribeForward(PortForward f) => f.Kind switch
    {
        ForwardKinds.Dynamic => $"SOCKS proxy on localhost:{f.ListenPort}",
        ForwardKinds.Remote => $"remote :{f.ListenPort} → {f.DestHost}:{f.DestPort}",
        _ => $"localhost:{f.ListenPort} → {f.DestHost}:{f.DestPort}",
    };

    /// <summary>Connections with an id, name and safe host, user, jump list and key path; at most 100.</summary>
    public static IReadOnlyList<SshConnection> Normalize(IReadOnlyList<SshConnection>? connections)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return (connections ?? [])
            .Select(c => c with
            {
                Name = c.Name?.Trim() ?? "",
                Host = c.Host?.Trim() ?? "",
                User = string.IsNullOrWhiteSpace(c.User) ? null : c.User.Trim(),
                Jump = string.IsNullOrWhiteSpace(c.Jump) ? null : string.Join(',', c.Jump.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)),
                Port = c.Port is > 0 and <= MaxPort ? c.Port : null,
                Identity = SshIdentities.All.Contains(c.Identity) ? c.Identity : SshIdentities.Agent,
                KeyPath = string.IsNullOrWhiteSpace(c.KeyPath) || c.KeyPath.Contains('"') ? null : c.KeyPath.Trim(),
                SecretRef = c.SecretRef?.Trim() is { Length: > 0 } r && r.StartsWith(OnePasswordScheme, StringComparison.Ordinal) && !r.Any(char.IsWhiteSpace) ? r : null,
                Tags = c.Tags?.Select(t => t.Trim()).Where(t => t.Length > 0).Distinct().ToList(),
            })
            .Where(c => c.Name.Length > 0 && c.Host.Length > 0 && !string.IsNullOrWhiteSpace(c.Id) && ids.Add(c.Id) &&
                        IsSafe(c.Host) && IsSafe(c.User) && IsSafe(c.Jump))
            .Take(MaxConnections)
            .ToList();
    }

    /// <summary>Forwards with valid ports and kinds, a target, and a destination where one's needed; at most 50.</summary>
    public static IReadOnlyList<PortForward> Normalize(IReadOnlyList<PortForward>? forwards)
    {
        var ids = new HashSet<string>(StringComparer.Ordinal);
        return (forwards ?? [])
            .Select(f => f with
            {
                Name = f.Name?.Trim() ?? "",
                Kind = ForwardKinds.All.Contains(f.Kind) ? f.Kind : ForwardKinds.Local,
                DestHost = string.IsNullOrWhiteSpace(f.DestHost) ? LocalHost : f.DestHost.Trim(),
            })
            .Where(f => !string.IsNullOrWhiteSpace(f.Id) && ids.Add(f.Id) && !string.IsNullOrWhiteSpace(f.Target) &&
                        f.ListenPort is > 0 and <= MaxPort && IsSafe(f.DestHost) &&
                        (f.Kind == ForwardKinds.Dynamic || f.DestPort is > 0 and <= MaxPort))
            .Take(MaxForwards)
            .ToList();
    }
}
