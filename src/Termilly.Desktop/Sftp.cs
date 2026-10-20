using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A folder on a server, as listed: its full path and what's in it.</summary>
internal sealed record RemoteListing(string Path, List<RemoteEntry> Entries);

/// <summary>A file or folder in a remote listing.</summary>
internal sealed record RemoteEntry(string Name, bool IsDirectory, long Size, string Modified, string Permissions);

/// <summary>
/// The SFTP side panel's file operations, for a terminal opened from an SSH host or connection: each runs
/// OpenSSH's sftp in batch mode with the terminal's own connection settings (host, user, port, jump hosts, key),
/// so nothing new has to be set up or stored. BatchMode means it never waits for a password nobody can type.
/// </summary>
internal sealed partial class Sftp(IProcessRunner runner)
{
    /// <summary>How long one batch of operations may take (an upload of a large file, a slow server).</summary>
    private static readonly TimeSpan BatchTimeout = TimeSpan.FromMinutes(10);
    /// <summary>A listing that takes longer than this has lost its server.</summary>
    private static readonly TimeSpan ListTimeout = TimeSpan.FromMinutes(1);
    private const string WorkingDirectoryLine = "Remote working directory: ";
    private const string Prompt = "sftp>";

    private static readonly string Exe = SshConnections.OpenSshProgram(SshConnections.SftpProgram);

    /// <summary>The parts of a listing line (<see cref="LongListing"/>'s groups) that are read.</summary>
    private static class Parts
    {
        public const string Name = "name";
        public const string Permissions = "perm";
        public const string Size = "size";
        public const string Date = "date";
    }

    /// <summary>A folder's own entry and its parent's, left out of a listing.</summary>
    private static readonly string[] DotEntries = [".", ".."];

    /// <summary>Where downloads go: the user's Downloads folder (TERMILLY_DOWNLOAD_DIR overrides it, for tests).</summary>
    public static string DownloadDirectory =>
        Environment.GetEnvironmentVariable("TERMILLY_DOWNLOAD_DIR") is { Length: > 0 } dir
            ? dir
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads");

    /// <summary>
    /// sftp's arguments from an ssh command line ("ssh.exe -p 2222 -J jump -i "key" user@host", ssh off Windows): the same options,
    /// with sftp's capital -P for the port. Null when the command isn't one sftp can follow.
    /// </summary>
    public static string? ArgumentsFor(string sshCommandLine)
    {
        var ssh = SessionProfiles.SshCommand + " ";
        if (!sshCommandLine.StartsWith(ssh, StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }
        var args = sshCommandLine[ssh.Length..].Trim();
        return SshPort().Replace(args, "-P $1");
    }

    [GeneratedRegex(@"(?<![\w-])-p (\d+)")]
    private static partial Regex SshPort();

    /// <summary>A path for an sftp batch line: quoted, with quotes and backslashes escaped.</summary>
    public static string Quote(string path) => $"\"{path.Replace("\\", "\\\\").Replace("\"", "\\\"")}\"";

    /// <summary>Runs sftp commands; returns its output, or throws with sftp's own message.</summary>
    public string Run(string arguments, IEnumerable<string> commands, TimeSpan? timeout = null)
    {
        var batch = Path.GetTempFileName();
        try
        {
            File.WriteAllLines(batch, commands, new UTF8Encoding(false));
            var result = runner.Run(new ProcessRequest(Exe, [])
            {
                CommandLine = $"-o BatchMode=yes -o ConnectTimeout=15 -b \"{batch}\" {arguments}",
                Timeout = timeout ?? BatchTimeout,
            });
            if (!result.Succeeded)
            {
                var message = result.ErrorLines.LastOrDefault(l => !l.StartsWith(Prompt, StringComparison.Ordinal));
                throw new IOException(message ?? $"sftp failed ({result.ExitCode}).");
            }
            return result.Text;
        }
        finally
        {
            File.Delete(batch);
        }
    }

    /// <summary>A folder's entries ("~" or empty: the home folder) and the folder's full path.</summary>
    public RemoteListing List(string arguments, string? directory)
    {
        var commands = new List<string>();
        if (!string.IsNullOrEmpty(directory) && directory != "~")
        {
            // sftp doesn't expand "~", but it starts in the home folder, so "~/dir" is just "dir".
            commands.Add($"cd {Quote(directory.StartsWith("~/", StringComparison.Ordinal) ? directory[2..] : directory)}");
        }
        commands.Add("pwd");
        commands.Add("ls -la");
        var output = Run(arguments, commands, ListTimeout);
        return new(ParsePwd(output) ?? directory ?? "~", ParseListing(output));
    }

    public static string? ParsePwd(string output) =>
        output.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.StartsWith(WorkingDirectoryLine, StringComparison.Ordinal))?[WorkingDirectoryLine.Length..];

    /// <summary>
    /// `ls -la` lines: "drwxr-xr-x  2 user group 4096 Oct  9 12:00 name" (Windows' sftp shows "drwx******  ?" for
    /// the permissions and link count). "." and ".." are left out; folders come first, then files, by name.
    /// </summary>
    public static List<RemoteEntry> ParseListing(string output)
    {
        var entries = new List<RemoteEntry>();
        foreach (var raw in output.Split('\n'))
        {
            var m = LongListing().Match(raw.TrimEnd('\r'));
            if (!m.Success)
            {
                continue;
            }
            var name = m.Groups[Parts.Name].Value;
            var kind = m.Groups[Parts.Permissions].Value[0];
            if (DotEntries.Contains(name))
            {
                continue;
            }
            if (kind == 'l' && name.Contains(" -> "))
            {
                name = name[..name.IndexOf(" -> ", StringComparison.Ordinal)];
            }
            entries.Add(new RemoteEntry(
                name, kind == 'd', long.TryParse(m.Groups[Parts.Size].Value, CultureInfo.InvariantCulture, out var size) ? size : 0,
                m.Groups[Parts.Date].Value, m.Groups[Parts.Permissions].Value));
        }
        return entries.OrderBy(e => !e.IsDirectory).ThenBy(e => e.Name, StringComparer.OrdinalIgnoreCase).ToList();
    }

    [GeneratedRegex(@"^(?<perm>[dlcbps-][rwxsStT*-]{9}[.+@]?)\s+(?:\d+|\?)\s+\S+\s+\S+\s+(?<size>\d+)\s+(?<date>\w{3}\s+\d{1,2}\s+(?:\d{1,2}:\d{2}|\d{4}))\s(?<name>.+)$")]
    private static partial Regex LongListing();

    /// <summary>Joins a remote folder and a name with forward slashes.</summary>
    public static string Join(string directory, string name) => directory.EndsWith('/') ? directory + name : $"{directory}/{name}";
}
