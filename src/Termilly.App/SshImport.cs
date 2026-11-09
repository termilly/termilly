using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using System.Xml.Linq;
using Microsoft.Win32;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>An SSH session found in another app, to import as a connection (never with its password).</summary>
internal sealed record ImportedHost(string Source, string Name, string Host, string? User, int? Port, string? KeyPath);

/// <summary>
/// Reads the SSH sessions saved by PuTTY (registry), MobaXterm (MobaXterm.ini), SecureCRT (session .ini files) and
/// mRemoteNG (confCons.xml), so moving to Termilly doesn't mean typing them again. Only host, user, port and key
/// file come across; stored passwords are left behind.
/// </summary>
internal static partial class SshImport
{
    /// <summary>The apps sessions are imported from, as an imported host names its source.</summary>
    private static class Sources
    {
        public const string PuTTY = "PuTTY";
        public const string MobaXterm = "MobaXterm";
        public const string SecureCrt = "SecureCRT";
        public const string MRemoteNg = "mRemoteNG";
    }

    private const string MobaXtermIni = "MobaXterm.ini";
    private const string IniExtension = ".ini";
    /// <summary>SecureCRT's own files in its session folder (__FolderData__.ini), not sessions.</summary>
    private const string SecureCrtOwnFile = "__";
    private const string MRemoteNgFile = "confCons.xml";
    /// <summary>PuTTY's protocol value for an SSH session (the default when none is set).</summary>
    private const string PuTTYSsh = "ssh";
    /// <summary>The setting that names a session's protocol (PuTTY's value, mRemoteNG's attribute).</summary>
    private const string Protocol = "Protocol";
    /// <summary>MobaXterm's session type for SSH, in a bookmark's "#icon#type%" start.</summary>
    private const string MobaSshType = "0";

    /// <summary>A MobaXterm bookmark's %-separated fields after its type, in order; the key file is a later one.</summary>
    private enum MobaField { Host, Port, User, Extra }

    /// <summary>mRemoteNG's confCons.xml names.</summary>
    private static class MRemote
    {
        public const string Node = "Node";
        public const string Type = "Type";
        public const string Connection = "Connection";
        public const string Name = "Name";
        public const string Hostname = "Hostname";
        public const string Username = "Username";
        public const string Port = "Port";
        public const string FullFileEncryption = "FullFileEncryption";
        public const string SshPrefix = "SSH";
        public const string Yes = "true";
    }

    public static List<ImportedHost> FindAll(List<string> notes)
    {
        var hosts = new List<ImportedHost>();
        Try(Sources.PuTTY, () => hosts.AddRange(PuTTY()), notes);
        foreach (var ini in MobaXtermFiles())
        {
            Try(Sources.MobaXterm, () => hosts.AddRange(MobaXterm(File.ReadAllText(ini))), notes);
        }
        var secureCrt = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "VanDyke", "Config", "Sessions");
        if (Directory.Exists(secureCrt))
        {
            foreach (var file in Directory.EnumerateFiles(secureCrt, "*" + IniExtension, SearchOption.AllDirectories).Where(f => !Path.GetFileName(f).StartsWith(SecureCrtOwnFile, StringComparison.Ordinal)))
            {
                Try(Sources.SecureCrt, () => { if (SecureCrt(Path.GetRelativePath(secureCrt, file)[..^IniExtension.Length].Replace('\\', '/'), File.ReadAllText(file)) is { } h) { hosts.Add(h); } }, notes);
            }
        }
        var mremote = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Sources.MRemoteNg, MRemoteNgFile);
        if (File.Exists(mremote))
        {
            Try(Sources.MRemoteNg, () => hosts.AddRange(MRemoteNg(File.ReadAllText(mremote), notes)), notes);
        }
        return hosts;
    }

    /// <summary>A port worth keeping: a valid one other than ssh's default.</summary>
    private static int? PortOf(int? port) => port is > 0 and <= SshConnections.MaxPort and not SshConnections.DefaultPort ? port : null;

    private static void Try(string source, Action read, List<string> notes)
    {
        try
        {
            read();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is FormatException or System.Xml.XmlException or System.Security.SecurityException)
        {
            notes.Add($"{source}: {e.Message}");
        }
    }

    // ---- PuTTY: HKCU\Software\SimonTatham\PuTTY\Sessions\<name> ----

    private static IEnumerable<ImportedHost> PuTTY()
    {
        if (!OperatingSystem.IsWindows())
        {
            yield break;
        }
        using var sessions = Registry.CurrentUser.OpenSubKey(@"Software\SimonTatham\PuTTY\Sessions");
        if (sessions is null)
        {
            yield break;
        }
        foreach (var name in sessions.GetSubKeyNames())
        {
            using var key = sessions.OpenSubKey(name);
            var values = new Dictionary<string, object?>(StringComparer.OrdinalIgnoreCase);
            foreach (var value in key?.GetValueNames() ?? [])
            {
                values[value] = key!.GetValue(value);
            }
            if (PuTTYSession(name, values) is { } host)
            {
                yield return host;
            }
        }
    }

    /// <summary>One PuTTY session: SSH ones with a host only. Names are stored %-encoded.</summary>
    public static ImportedHost? PuTTYSession(string encodedName, IReadOnlyDictionary<string, object?> values)
    {
        string? Text(string name) => values.TryGetValue(name, out var v) && v is string s && s.Length > 0 ? s : null;
        var name = Uri.UnescapeDataString(encodedName);
        if (name == "Default Settings" || Text("HostName") is not { } host || (Text(Protocol) ?? PuTTYSsh) != PuTTYSsh)
        {
            return null;
        }
        var (user, hostOnly) = host.Contains('@') ? (host[..host.LastIndexOf('@')], host[(host.LastIndexOf('@') + 1)..]) : (Text("UserName"), host);
        var port = values.TryGetValue("PortNumber", out var p) && p is int n ? PortOf(n) : null;
        return new ImportedHost(Sources.PuTTY, name, hostOnly, user, port, Text("PublicKeyFile"));
    }

    // ---- MobaXterm: [Bookmarks…] in MobaXterm.ini ----

    private static IEnumerable<string> MobaXtermFiles()
    {
        var candidates = new[]
        {
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), Sources.MobaXterm, MobaXtermIni),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), Sources.MobaXterm, MobaXtermIni),
        };
        return candidates.Where(File.Exists);
    }

    /// <summary>
    /// SSH bookmarks: lines "Name=#109#0%host%port%user%…" (#109 is the SSH icon, 0 the SSH session type) in
    /// [Bookmarks] sections. The key file, when there is one, is a later field with a path in it.
    /// </summary>
    public static IEnumerable<ImportedHost> MobaXterm(string ini)
    {
        var inBookmarks = false;
        foreach (var raw in ini.Split('\n'))
        {
            var line = raw.Trim();
            if (line.StartsWith('['))
            {
                inBookmarks = line.StartsWith("[Bookmarks", StringComparison.OrdinalIgnoreCase);
                continue;
            }
            var eq = line.IndexOf('=');
            if (!inBookmarks || eq <= 0)
            {
                continue;
            }
            var value = line[(eq + 1)..];
            var m = MobaSession().Match(value);
            if (!m.Success || m.Groups[1].Value != MobaSshType)
            {
                continue; // not SSH
            }
            var fields = value[(value.IndexOf('%') + 1)..].Split('%');
            if (fields.Length < (int)MobaField.Extra || fields[(int)MobaField.Host].Length == 0)
            {
                continue;
            }
            var port = int.TryParse(fields[(int)MobaField.Port], out var n) ? PortOf(n) : null;
            var key = fields.Skip((int)MobaField.Extra).FirstOrDefault(f => f.Contains(".ppk", StringComparison.OrdinalIgnoreCase) || f.Contains("id_", StringComparison.OrdinalIgnoreCase));
            var user = fields[(int)MobaField.User];
            yield return new ImportedHost(Sources.MobaXterm, line[..eq].Trim(), fields[(int)MobaField.Host], user.Length > 0 ? user : null, port, key?.Replace("_CurrentDrive_", "C"));
        }
    }

    [GeneratedRegex(@"^#\d+#(\d+)%")]
    private static partial Regex MobaSession();

    // ---- SecureCRT: one .ini per session ----

    /// <summary>A SecureCRT session file: S:"Hostname", S:"Username", D:"[SSH2] Port" (hex), SSH2 or SSH1 only.</summary>
    public static ImportedHost? SecureCrt(string name, string ini)
    {
        string? Value(string key) => ini.Split('\n').Select(l => l.Trim())
            .FirstOrDefault(l => l.StartsWith(key + "=", StringComparison.OrdinalIgnoreCase))?[(key.Length + 1)..].Trim();
        var protocol = Value("S:\"Protocol Name\"");
        if (Value("S:\"Hostname\"") is not { Length: > 0 } host || protocol is not ("SSH2" or "SSH1"))
        {
            return null;
        }
        var port = int.TryParse(Value("D:\"[SSH2] Port\""), NumberStyles.HexNumber, CultureInfo.InvariantCulture, out var n) ? PortOf(n) : null;
        var key = Value("S:\"Identity Filename V2\"")?.Split(':').FirstOrDefault();
        return new ImportedHost(Sources.SecureCrt, name, host, Value("S:\"Username\"") is { Length: > 0 } u ? u : null, port, string.IsNullOrEmpty(key) ? null : key);
    }

    // ---- mRemoteNG: confCons.xml ----

    /// <summary>SSH connections (Protocol SSH1/SSH2) in a confCons.xml; a fully encrypted file can't be read.</summary>
    public static IEnumerable<ImportedHost> MRemoteNg(string xml, List<string> notes)
    {
        var doc = XDocument.Parse(xml);
        if ((string?)doc.Root?.Attribute(MRemote.FullFileEncryption) == MRemote.Yes)
        {
            notes.Add("mRemoteNG: the connection file is encrypted; export it unencrypted to import it.");
            return [];
        }
        return doc.Descendants(MRemote.Node)
            .Where(n => (string?)n.Attribute(MRemote.Type) == MRemote.Connection && ((string?)n.Attribute(Protocol))?.StartsWith(MRemote.SshPrefix, StringComparison.Ordinal) == true)
            .Select(n => new ImportedHost(
                Sources.MRemoteNg,
                (string?)n.Attribute(MRemote.Name) ?? "",
                (string?)n.Attribute(MRemote.Hostname) ?? "",
                (string?)n.Attribute(MRemote.Username) is { Length: > 0 } u ? u : null,
                int.TryParse((string?)n.Attribute(MRemote.Port), out var p) ? PortOf(p) : null,
                null))
            .Where(h => h.Host.Length > 0)
            .ToList();
    }
}
