namespace Termilly.Desktop;

/// <summary>Where a profile came from, for grouping in the page's lists (SessionProfile.Source).</summary>
internal static class ProfileSources
{
    /// <summary>A shell found on this machine.</summary>
    public const string Local = "local";
    public const string Wsl = "wsl";
    /// <summary>The user's own, from Settings.</summary>
    public const string Custom = "custom";
    /// <summary>A host in ~/.ssh/config, or an SSH connection from Settings.</summary>
    public const string Ssh = "ssh";
    /// <summary>A COM port, or a network console.</summary>
    public const string Serial = "serial";
    /// <summary>A running Docker container (DynamicSources.cs).</summary>
    public const string Docker = "docker";
    /// <summary>A pod in a Kubernetes context (DynamicSources.cs).</summary>
    public const string Kubernetes = "k8s";
}

/// <summary>The badge a profile shows (js/sidebar.js draws each).</summary>
internal static class ProfileIcons
{
    public const string PowerShell = "powershell";
    public const string Cmd = "cmd";
    public const string Bash = "bash";
    public const string Wsl = ProfileSources.Wsl;
    public const string Ssh = ProfileSources.Ssh;
    public const string Serial = ProfileSources.Serial;
    public const string Docker = ProfileSources.Docker;
    public const string Kubernetes = ProfileSources.Kubernetes;
    public const string Custom = ProfileSources.Custom;
}

/// <summary>
/// The ids of profiles Termilly makes from what it finds: a prefix per kind, then the thing's own name or id
/// ("wsl-ubuntu", "conn-&lt;connection id&gt;"). The page keeps a terminal's profile id with it, so these stay as they are.
/// </summary>
internal static class ProfileIds
{
    public const string Wsl = "wsl-";
    /// <summary>An SSH connection defined in Settings.</summary>
    public const string Connection = "conn-";
    /// <summary>A host in ~/.ssh/config.</summary>
    public const string SshHost = "ssh-";
    public const string SerialPort = "serial-";
    public const string NetworkConsole = "netcon-";
    public const string Docker = "docker-";
    public const string Kubernetes = "k8s-";
}

/// <summary>Tags Termilly gives profiles itself.</summary>
internal static class ProfileTags
{
    /// <summary>A host, container or pod whose name says it's production: the page's production environment matches it.</summary>
    public const string Production = "prod";
}

/// <summary>
/// The command lines of terminals on a byte stream rather than a shell: "serial:COM3" for a COM port, "net:&lt;id&gt;"
/// for a network console from Settings.
/// </summary>
internal static class StreamCommands
{
    public const string Serial = "serial:";
    public const string Network = "net:";

    /// <summary>What follows the prefix, when the command line has it.</summary>
    public static string? Target(string commandLine, string prefix) =>
        commandLine.StartsWith(prefix, StringComparison.Ordinal) ? commandLine[prefix.Length..] : null;
}
