namespace Termilly.Desktop.Messaging;

// SSH (Settings › SSH: imports, saved passwords, port forwards) and the SFTP side panel.

/// <summary>The SFTP panel's file operations (the sftp:op message's op).</summary>
internal static class SftpOperations
{
    public const string Get = "get";
    public const string Remove = "rm";
    public const string RemoveDirectory = "rmdir";
    public const string MakeDirectory = "mkdir";
    public const string Rename = "rename";
}

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

    /// <param name="Id">The port forward.</param>
    internal sealed record ForwardStart(string Id = "") : IPageMessage
    {
        public static string Type => "forward:start";
    }

    internal sealed record ForwardStop(string Id = "") : IPageMessage
    {
        public static string Type => "forward:stop";
    }

    /// <param name="Id">The SSH terminal whose server it lists.</param>
    internal sealed record SftpList(string Id = "", string? RequestId = null, string? Path = null) : IPageMessage
    {
        public static string Type => "sftp:list";
    }

    /// <param name="Op">One of <see cref="SftpOperations"/>.</param>
    /// <param name="To">A rename's new path.</param>
    internal sealed record SftpOp(string Id = "", string? RequestId = null, string? Op = null, string? Path = null, string? To = null) : IPageMessage
    {
        public static string Type => "sftp:op";
    }

    /// <summary>Uploads into <see cref="Dir"/>: the files the browser handed over, or <see cref="Paths"/>.</summary>
    internal sealed record SftpPut(string Id = "", string? RequestId = null, string? Dir = null, IReadOnlyList<string>? Paths = null) : IPageMessage
    {
        public static string Type => "sftp:put";
    }

    /// <summary>The Upload button where the host's own dialog picks the files.</summary>
    internal sealed record SftpPick(string Id = "", string? RequestId = null, string? Dir = null) : IPageMessage
    {
        public static string Type => "sftp:pick";
    }
}

internal static partial class ToPage
{
    internal sealed record SshImported(object Hosts, IReadOnlyList<string> Notes) : IHostMessage
    {
        public static string Type => "ssh:imported";
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

    internal sealed record SftpListing(string? RequestId, string Path, object Entries) : IHostMessage
    {
        public static string Type => "sftp:listing";
    }

    internal sealed record SftpListingFailed(string? RequestId, string Message) : IHostMessage
    {
        public static string Type => "sftp:listing";

        public bool Ok { get; }
    }

    /// <param name="Local">Where a download was saved.</param>
    internal sealed record SftpDone(string? RequestId, string? Local) : IHostMessage
    {
        public static string Type => "sftp:done";

        public bool Ok { get; } = true;
    }

    internal sealed record SftpFailed(string? RequestId, string Message) : IHostMessage
    {
        public static string Type => "sftp:done";

        public bool Ok { get; }
    }

    internal sealed record SftpUploaded(string? RequestId, string File) : IHostMessage
    {
        public static string Type => "sftp:done";

        public bool Ok { get; } = true;
    }

    internal sealed record SftpUploadFailed(string? RequestId, string File, string Message) : IHostMessage
    {
        public static string Type => "sftp:done";

        public bool Ok { get; }
    }

    /// <summary>The files picked for an upload, each reported as it's done.</summary>
    internal sealed record SftpQueued(string? RequestId, IEnumerable<string?> Files) : IHostMessage
    {
        public static string Type => "sftp:queued";
    }
}
