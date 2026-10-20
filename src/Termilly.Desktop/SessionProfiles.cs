using System.IO;
using System.Text.RegularExpressions;
using Microsoft.Win32;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Something a terminal can be opened with. Every kind of session (local shell, WSL, SSH, a custom command) is a
/// local process under the pseudo console, so a profile is a command line plus where and how to start it.
/// </summary>
/// <param name="Icon">Badge key the page uses to draw the menu icon.</param>
/// <param name="Source">Where it came from, for grouping: one of <see cref="ProfileSources"/>.</param>
/// <param name="WorkingDirectory">Start folder; when null the workspace's folder is used.</param>
/// <param name="Tags">Tags a new terminal of this profile starts with.</param>
internal sealed record SessionProfile(
    string Id,
    string Name,
    string Description,
    string Icon,
    string CommandLine,
    string Source,
    string? WorkingDirectory = null,
    IReadOnlyDictionary<string, string>? Environment = null,
    IReadOnlyList<string>? Tags = null);

/// <summary>
/// The profiles on offer: shells found on this machine, WSL distributions, the user's own profiles from Settings,
/// and the hosts in ~/.ssh/config. Ctrl+Shift+1–9 follows this order.
/// </summary>
internal static partial class SessionProfiles
{
    /// <summary>The shells found on this machine, by their ids.</summary>
    private static class Shells
    {
        public const string Pwsh = "pwsh";
        public const string WindowsPowerShell = "powershell";
        public const string Cmd = "cmd";
        public const string GitBash = "git-bash";
        public const string Sh = "sh";

        public const string PwshExe = "pwsh.exe";
        public const string WindowsPowerShellExe = "powershell.exe";
        public const string CmdExe = "cmd.exe";
        public const string WslExe = "wsl.exe";
        /// <summary>How PowerShell 7 is named in the list.</summary>
        public const string PowerShellName = "PowerShell";
    }

    /// <summary>Files in /etc/shells that aren't shells for people: no login, restricted, or the dash behind sh.</summary>
    private static readonly string[] NotForPeople = ["nologin", "false", "rbash", Shells.Sh, "dash"];
    private const string UnixSh = "/bin/sh";

    /// <summary>The characters WSL allows in distribution names.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9._-]+$")]
    private static partial Regex ValidDistroName();

    /// <summary>"prod" or "production" as a word of a host name or alias (not "product").</summary>
    [GeneratedRegex(@"(?<![a-z])prod(uction)?(?![a-z])", RegexOptions.IgnoreCase)]
    private static partial Regex LooksLikeProduction();

    public static IReadOnlyList<SessionProfile> Detect(AppSettings settings, string? sshConfigPath = null)
    {
        var profiles = new List<SessionProfile>();
        profiles.AddRange(LocalShells());
        profiles.AddRange(WslShells());
        profiles.AddRange(CustomShells(settings.Shells.Profiles ?? [], profiles));
        profiles.AddRange(Connections(settings.Ssh.Connections ?? [], profiles));
        profiles.AddRange(SshHosts(sshConfigPath ?? SshConfig.DefaultPath, profiles));
        profiles.AddRange(SerialProfiles(settings));
        return profiles;
    }

    private static IEnumerable<SessionProfile> LocalShells()
    {
        if (!OperatingSystem.IsWindows())
        {
            foreach (var shell in UnixShells())
            {
                yield return shell;
            }
            yield break;
        }
        yield return FindOnPath(Shells.PwshExe) is not null
            ? new SessionProfile(Shells.Pwsh, Shells.PowerShellName, Shells.PwshExe, ProfileIcons.PowerShell, "pwsh.exe -NoLogo", ProfileSources.Local)
            : new SessionProfile(Shells.WindowsPowerShell, "Windows PowerShell", Shells.WindowsPowerShellExe, ProfileIcons.PowerShell, "powershell.exe -NoLogo", ProfileSources.Local);

        yield return new SessionProfile(Shells.Cmd, "Command Prompt", Shells.CmdExe, ProfileIcons.Cmd, Shells.CmdExe, ProfileSources.Local);

        if (FindGitBash() is { } gitBash)
        {
            yield return new SessionProfile(Shells.GitBash, "Git Bash", "Git for Windows", ProfileIcons.Bash, $"\"{gitBash}\" --login -i", ProfileSources.Local);
        }
    }

    /// <summary>The ssh client: Windows' ssh.exe, or ssh on other systems.</summary>
    internal static string SshCommand => AppPaths.Exe(SshConnections.SshProgram);

    /// <summary>
    /// Shells on Linux and other Unix systems: the login shell ($SHELL) first, then the others listed in /etc/shells
    /// that exist, one per name (bash, zsh, fish…), started as login shells so the profile is read.
    /// </summary>
    private static IEnumerable<SessionProfile> UnixShells()
    {
        var paths = new List<string>();
        if (Environment.GetEnvironmentVariable("SHELL") is { Length: > 0 } login)
        {
            paths.Add(login);
        }
        try
        {
            paths.AddRange(File.ReadAllLines("/etc/shells").Select(l => l.Trim()).Where(l => l.StartsWith('/')));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
        }
        var seen = new HashSet<string>();
        foreach (var path in paths.Where(File.Exists))
        {
            var name = Path.GetFileName(path);
            // Shells that aren't for people (nologin, rbash, the dash behind sh) are left out.
            if (NotForPeople.Contains(name) || !seen.Add(name))
            {
                continue;
            }
            // PowerShell gets its own integration (shell/termilly.ps1); its -Login must come first.
            yield return name == Shells.Pwsh
                ? new SessionProfile(name, Shells.PowerShellName, path, ProfileIcons.PowerShell, $"{path} -Login -NoLogo", ProfileSources.Local)
                : new SessionProfile(name, name, path, ProfileIcons.Bash, $"{path} -l", ProfileSources.Local);
        }
        if (seen.Count == 0)
        {
            yield return new SessionProfile(Shells.Sh, Shells.Sh, UnixSh, ProfileIcons.Bash, UnixSh, ProfileSources.Local);
        }
    }

    private static IEnumerable<SessionProfile> WslShells()
    {
        foreach (var distro in WslDistributions())
        {
            // wsl.exe takes quotes around the name literally; valid names have no spaces, so none are needed.
            yield return new SessionProfile(
                ProfileIds.Wsl + distro.ToLowerInvariant(), distro, "WSL", ProfileIcons.Wsl, $"wsl.exe -d {distro} --cd ~", ProfileSources.Wsl);
        }
    }

    /// <summary>The user's profiles, minus any whose id clashes with one already listed.</summary>
    private static IEnumerable<SessionProfile> CustomShells(IEnumerable<CustomProfile> custom, List<SessionProfile> listed) =>
        custom
            .Where(p => listed.All(l => l.Id != p.Id))
            .Select(p => new SessionProfile(
                p.Id, p.Name, p.CommandLine, p.Icon, p.CommandLine, ProfileSources.Custom, p.WorkingDirectory, p.Environment, p.Tags));

    /// <summary>
    /// The SSH connections defined in Termilly (Settings › SSH): ssh with their port, jump hosts and key, and the
    /// askpass helper for a password reference. Named like production, they start tagged prod.
    /// </summary>
    internal static IEnumerable<SessionProfile> Connections(IEnumerable<SshConnection> connections, List<SessionProfile> listed, string? agentDirectory = null)
    {
        agentDirectory ??= AgentHooks.AgentDirectory;
        foreach (var c in connections)
        {
            var id = ProfileIds.Connection + c.Id;
            if (listed.Any(l => l.Id == id))
            {
                continue;
            }
            var production = LooksLikeProduction().IsMatch(c.Name) || LooksLikeProduction().IsMatch(c.Host);
            var tags = (c.Tags ?? []).Concat(production ? [ProfileTags.Production] : []).Distinct().ToList();
            yield return new SessionProfile(
                id, c.Name, SshConnections.Describe(c), ProfileIcons.Ssh, $"{SshCommand} {SshConnections.Arguments(c)}", ProfileSources.Ssh,
                Environment: SshConnections.EnvironmentFor(c, agentDirectory), Tags: tags.Count > 0 ? tags : null);
        }
    }

    /// <summary>
    /// COM ports on this PC (with their saved line settings) and the network consoles from Settings › Serial. They
    /// aren't command lines: StartSession opens them as byte streams (SerialConsole.cs).
    /// </summary>
    internal static IEnumerable<SessionProfile> SerialProfiles(AppSettings settings, IReadOnlyList<(string Port, string FriendlyName)>? ports = null)
    {
        foreach (var (port, friendly) in ports ?? Desktop.SerialPorts.Detect())
        {
            var saved = settings.Shells.SerialPorts?.FirstOrDefault(s => s.Port.Equals(port, StringComparison.OrdinalIgnoreCase)) ?? new SerialSettings(port);
            var description = friendly == port ? Desktop.SerialPorts.Describe(saved) : $"{friendly.Replace($" ({port})", "")} · {Desktop.SerialPorts.Describe(saved)}";
            yield return new SessionProfile(ProfileIds.SerialPort + port.ToLowerInvariant(), port, description, ProfileIcons.Serial, StreamCommands.Serial + port, ProfileSources.Serial);
        }
        foreach (var c in settings.Shells.NetworkConsoles ?? [])
        {
            yield return new SessionProfile(
                ProfileIds.NetworkConsole + c.Id, c.Name, $"{c.Host}:{c.Port} · {NetworkProtocols.Describe(c.Protocol)}", ProfileIcons.Serial, StreamCommands.Network + c.Id,
                ProfileSources.Serial, Tags: c.Tags is { Count: > 0 } ? c.Tags : null);
        }
    }

    /// <summary>One profile per concrete host in the SSH config, opened with the system's OpenSSH client.</summary>
    internal static IEnumerable<SessionProfile> SshHosts(string configPath, List<SessionProfile> listed)
    {
        if (FindOnPath(SshCommand) is null)
        {
            yield break;
        }

        foreach (var host in SshConfig.Read(configPath))
        {
            var id = ProfileIds.SshHost + host.Alias.ToLowerInvariant();
            if (listed.Any(l => l.Id == id))
            {
                continue;
            }

            var target = host.HostName ?? host.Alias;
            var description = (host.User is null ? target : $"{host.User}@{target}") + (host.ProxyJump is null ? "" : $" via {host.ProxyJump}");
            var production = LooksLikeProduction().IsMatch(host.Alias) || LooksLikeProduction().IsMatch(target);
            yield return new SessionProfile(
                id, host.Alias, description, ProfileIcons.Ssh, $"{SshCommand} {host.Alias}", ProfileSources.Ssh, Tags: production ? [ProfileTags.Production] : null);
        }
    }

    private static string? FindOnPath(string exe) =>
        (Environment.GetEnvironmentVariable(SystemVariables.Path) ?? "")
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries) // ';' on Windows, ':' elsewhere
            .Select(dir => Path.Combine(dir, exe))
            .FirstOrDefault(File.Exists);

    private static string? FindGitBash()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }
        var installPath = Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\GitForWindows", "InstallPath", null) as string;
        var candidates = new[]
        {
            installPath,
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), GitForWindows.Folder),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), GitForWindows.UserPrograms, GitForWindows.Folder),
        };
        return candidates
            .Where(dir => !string.IsNullOrEmpty(dir))
            .Select(dir => Path.Combine(dir!, GitForWindows.Bin, GitForWindows.BashExe))
            .FirstOrDefault(File.Exists);
    }

    /// <summary>Registered WSL distributions, read from the registry so no wsl.exe process is started.</summary>
    private static IEnumerable<string> WslDistributions()
    {
        if (!OperatingSystem.IsWindows())
        {
            yield break;
        }
        using var lxss = Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Lxss");
        if (lxss is null || FindOnPath(Shells.WslExe) is null)
        {
            yield break;
        }

        foreach (var keyName in lxss.GetSubKeyNames())
        {
            using var distro = lxss.OpenSubKey(keyName);
            if (distro?.GetValue("DistributionName") is string name &&
                ValidDistroName().IsMatch(name) &&
                !name.StartsWith("docker-desktop", StringComparison.OrdinalIgnoreCase))
            {
                yield return name;
            }
        }
    }
}
