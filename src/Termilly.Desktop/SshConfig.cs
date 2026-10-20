using System.IO;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A host alias from an OpenSSH config file, with what's useful to show next to it.</summary>
internal sealed record SshHost(string Alias, string? HostName, string? User, string? ProxyJump = null);

/// <summary>
/// Reads the host aliases from an OpenSSH client config (~/.ssh/config), so each can open as <c>ssh alias</c>.
/// Only concrete aliases count: patterns (<c>*</c>, <c>?</c>, <c>!negated</c>) and <c>Match</c> blocks don't name a
/// host to connect to. Everything else about the connection stays with ssh, which reads the same file.
/// </summary>
internal static partial class SshConfig
{
    /// <summary>Characters an alias may have to be passed to ssh on a command line as is.</summary>
    [GeneratedRegex(@"^[A-Za-z0-9._@:-]+$")]
    private static partial Regex SafeAlias();

    private const int MaxIncludeDepth = 8;
    /// <summary>OpenSSH's folder in the profile, and its client config in it.</summary>
    private const string SshFolder = ".ssh";
    private const string ConfigFile = "config";

    public static string DefaultPath =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), SshFolder, ConfigFile);

    /// <summary>Hosts in file order (first mention wins), following <c>Include</c>; empty if the file is missing.</summary>
    public static IReadOnlyList<SshHost> Read(string path)
    {
        var hosts = new List<SshHost>();
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        try
        {
            ReadFile(path, Path.GetDirectoryName(path)!, hosts, seen, depth: 0);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // An unreadable config just means no SSH hosts.
        }
        return hosts;
    }

    /// <summary>Parses config text (no Include); for tests and the single-file case.</summary>
    public static IReadOnlyList<SshHost> Parse(string text)
    {
        var hosts = new List<SshHost>();
        ParseLines(text.Split('\n'), sshDir: null, hosts, new HashSet<string>(StringComparer.OrdinalIgnoreCase), depth: 0);
        return hosts;
    }

    private static void ReadFile(string path, string sshDir, List<SshHost> hosts, HashSet<string> seen, int depth)
    {
        if (depth > MaxIncludeDepth || !File.Exists(path))
        {
            return;
        }
        ParseLines(File.ReadAllLines(path), sshDir, hosts, seen, depth);
    }

    private static void ParseLines(IEnumerable<string> lines, string? sshDir, List<SshHost> hosts, HashSet<string> seen, int depth)
    {
        // The aliases of the Host block being read; HostName and User fill them in until the next block.
        var block = new List<int>();
        foreach (var raw in lines)
        {
            var (keyword, args) = Split(raw);
            switch (keyword)
            {
                case Keywords.Host:
                    block = AddHosts(args, hosts, seen);
                    break;
                case Keywords.Match:
                    block = [];
                    break;
                case Keywords.HostName when args.Count > 0:
                    Fill(block, hosts, h => h with { HostName = h.HostName ?? args[0] });
                    break;
                case Keywords.ProxyJump when args.Count > 0 && !args[0].Equals(NoJump, StringComparison.OrdinalIgnoreCase):
                    Fill(block, hosts, h => h with { ProxyJump = h.ProxyJump ?? args[0] });
                    break;
                case Keywords.User when args.Count > 0:
                    Fill(block, hosts, h => h with { User = h.User ?? args[0] });
                    break;
                case Keywords.Include when sshDir is not null:
                    foreach (var file in args.SelectMany(pattern => ExpandInclude(pattern, sshDir)))
                    {
                        ReadFile(file, sshDir, hosts, seen, depth + 1);
                    }
                    break;
            }
        }
    }

    /// <summary>The keywords read from ssh_config, lower-cased as <see cref="Split"/> gives them.</summary>
    private static class Keywords
    {
        public const string Host = "host";
        public const string Match = "match";
        public const string HostName = "hostname";
        public const string ProxyJump = "proxyjump";
        public const string User = "user";
        public const string Include = "include";
    }

    /// <summary>ProxyJump none: no jump host.</summary>
    private const string NoJump = "none";

    /// <summary>A Host line's aliases that name one host (no wildcards or negations), new ones only; their places in the list.</summary>
    private static List<int> AddHosts(IEnumerable<string> patterns, List<SshHost> hosts, HashSet<string> seen)
    {
        var block = new List<int>();
        foreach (var pattern in patterns)
        {
            if (pattern.IndexOfAny(['*', '?', '!']) >= 0 || !SafeAlias().IsMatch(pattern) || !seen.Add(pattern))
            {
                continue;
            }
            hosts.Add(new SshHost(pattern, null, null));
            block.Add(hosts.Count - 1);
        }
        return block;
    }

    /// <summary>Fills in the hosts of the block being read; the first value given for each wins, as in ssh.</summary>
    private static void Fill(List<int> block, List<SshHost> hosts, Func<SshHost, SshHost> fill)
    {
        foreach (var i in block)
        {
            hosts[i] = fill(hosts[i]);
        }
    }

    /// <summary>A line's lower-cased keyword and its arguments (quoted ones may hold spaces); null for blanks and comments.</summary>
    private static (string? Keyword, List<string> Args) Split(string line)
    {
        var text = line.Trim();
        if (text.Length == 0 || text[0] == '#')
        {
            return (null, []);
        }

        // "Keyword value" or "Keyword=value".
        var end = text.IndexOfAny([' ', '\t', '=']);
        if (end < 0)
        {
            return (text.ToLowerInvariant(), []);
        }

        var keyword = text[..end].ToLowerInvariant();
        var rest = text[end..].TrimStart(' ', '\t', '=').TrimStart();
        var args = new List<string>();
        foreach (Match m in Regex.Matches(rest, @"""([^""]*)""|(\S+)"))
        {
            if (m.Groups[2].Success && m.Groups[2].Value.StartsWith('#'))
            {
                break; // a trailing comment
            }
            args.Add(m.Groups[1].Success ? m.Groups[1].Value : m.Groups[2].Value);
        }
        return (keyword, args);
    }

    /// <summary>Files an Include names: relative to ~/.ssh, ~ expanded, wildcards in the file name.</summary>
    private static IEnumerable<string> ExpandInclude(string pattern, string sshDir)
    {
        var path = pattern.StartsWith('~')
            ? Environment.GetFolderPath(Environment.SpecialFolder.UserProfile) + pattern[1..]
            : Path.IsPathRooted(pattern) ? pattern : Path.Combine(sshDir, pattern);
        var dir = Path.GetDirectoryName(path);
        var name = Path.GetFileName(path);
        if (string.IsNullOrEmpty(dir) || string.IsNullOrEmpty(name) || !Directory.Exists(dir))
        {
            return [];
        }
        return Directory.GetFiles(dir, name).Order(StringComparer.OrdinalIgnoreCase);
    }
}
