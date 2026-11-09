namespace Termilly.Desktop.Messaging;

// SSH (Settings › SSH: imports, saved passwords, port forwards).

/// <summary>A port forward's state, as the page shows it.</summary>
internal static class ForwardStates
{
    public const string Starting = "starting";
    public const string Running = "running";
    public const string Stopped = "stopped";
    public const string Failed = "failed";
}

internal static partial class FromPage
{
    /// <summary>Finds hosts in other SSH clients' settings (PuTTY, SecureCRT, mRemoteNG…) to import.</summary>
    internal sealed record SshImport : IPageMessage
    {
        public static string Type => "ssh:import";
    }

    internal sealed record SshPassword(string? Connection = null, string? User = null, string? Password = null) : IPageMessage
    {
        public static string Type => "ssh:password";
    }

    internal sealed record SshPasswordForget(string? Connection = null) : IPageMessage
    {
        public static string Type => "ssh:passwordForget";
    }

    /// <summary>Which saved passwords exist, and each port forward's state.</summary>
    internal sealed record SshStatus : IPageMessage
    {
        public static string Type => "ssh:status";
    }

    /// <summary>The connection dialog opened: it lists the keys in ~/.ssh and spots a host ~/.ssh/config already has.</summary>
    internal sealed record SshKnown : IPageMessage
    {
        public static string Type => "ssh:known";
    }

    /// <param name="Id">The port forward.</param>
    internal sealed record ForwardStart(string Id = "") : IPageMessage
    {
        public static string Type => "forward:start";
    }

    internal sealed record ForwardStop(string Id = "") : IPageMessage
    {
        public static string Type => "forward:stop";
    }
}

internal static partial class ToPage
{
    internal sealed record SshImported(object Hosts, IReadOnlyList<string> Notes) : IHostMessage
    {
        public static string Type => "ssh:imported";
    }

    /// <summary>The private keys in ~/.ssh (full paths) and the hosts ~/.ssh/config names.</summary>
    internal sealed record SshKnown(IReadOnlyList<string> Keys, IReadOnlyList<SshHost> Hosts) : IHostMessage
    {
        public static string Type => "ssh:known";
    }

    /// <param name="Saved">Connection id: whether its password is saved.</param>
    internal sealed record SshCredentials(IReadOnlyDictionary<string, bool> Saved, bool Available, string Store) : IHostMessage
    {
        public static string Type => "ssh:credentials";
    }

    /// <summary>The credential store refused a change.</summary>
    internal sealed record SshError(string Message) : IHostMessage
    {
        public static string Type => "ssh:error";
    }

    internal sealed record ForwardStatus(string Id, string State, string? Message) : IHostMessage
    {
        public static string Type => "forward:status";
    }

    internal sealed record ForwardState(string State, string? Message);

    internal sealed record ForwardAll(IReadOnlyDictionary<string, ForwardState> States) : IHostMessage
    {
        public static string Type => "forward:all";
    }
}
