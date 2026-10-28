using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A server a terminal's files are on: its sftp arguments (Sftp.ArgumentsFor) and its ssh ones.</summary>
internal sealed record FileServer(string Sftp, string Ssh);

/// <summary>
/// The Files panel's "Copy to": a file or folder copied from one terminal's folders to another's, each side here
/// (null) or on a server. Here to here copies; between here and a server sftp puts or gets it (recursively); on one
/// server it's copied there, over ssh, without coming here; between two servers it comes through a temporary folder.
/// A folder merges into one of the same name, and a file replaces one.
/// </summary>
internal sealed class FileCopies(Sftp sftp, IProcessRunner runner)
{
    /// <summary>How long one item's copy may take (a large folder over a slow connection).</summary>
    private static readonly TimeSpan CopyTimeout = TimeSpan.FromHours(2);
    private const string TempPrefix = "termilly-copy-";

    public void Copy(FileServer? from, string source, FileServer? to, string target)
    {
        if (from is null && to is null)
        {
            LocalFiles.CopyTree(source, target);
        }
        else if (from is null)
        {
            Upload(to!, source, target);
        }
        else if (to is null)
        {
            sftp.Run(from.Sftp, [$"get -r {Sftp.Quote(source)} {Sftp.Quote(target)}"], CopyTimeout);
        }
        else if (from.Sftp == to.Sftp)
        {
            OnServer(from, source, target);
        }
        else
        {
            ThroughHere(from, source, to, target);
        }
    }

    /// <summary>The shell command that copies on a server: a folder's contents into the target folder (merging), else the file.</summary>
    public static string CopyCommand(string source, string target)
    {
        var (s, t) = (SshGitRunner.Quote(source), SshGitRunner.Quote(target));
        return $"if [ -d {s} ]; then mkdir -p {t} && cp -R {SshGitRunner.Quote(source.TrimEnd('/') + "/.")} {t}; else cp -f {s} {t}; fi";
    }

    /// <summary>
    /// The shell command that gives the folders an upload from Windows made the server's own folder permissions:
    /// Windows' sftp sends a mode of its own making for them (drwx---rwx), which the server keeps.
    /// </summary>
    public static string FolderModeCommand(string target) =>
        $"find {SshGitRunner.Quote(target)} -type d -perm {WindowsFolderMode} -exec chmod \"$(printf %o $((0777 & ~$(umask))))\" {{}} +";

    /// <summary>The mode Windows' sftp gives the folders it uploads.</summary>
    private const string WindowsFolderMode = "0707";

    private void Upload(FileServer server, string source, string target)
    {
        sftp.Run(server.Sftp, [$"put -r {Sftp.Quote(source)} {Sftp.Quote(target)}"], CopyTimeout);
        if (OperatingSystem.IsWindows() && Directory.Exists(source))
        {
            OnServer(server, FolderModeCommand(target));
        }
    }

    private void OnServer(FileServer server, string source, string target)
    {
        if (LocalFiles.IsInside(target, source, '/'))
        {
            throw new IOException("A folder can't be copied into itself.");
        }
        OnServer(server, CopyCommand(source, target));
    }

    /// <summary>Runs a shell command on the server, over ssh with the terminal's own settings; throws with its error.</summary>
    private void OnServer(FileServer server, string command)
    {
        var result = runner.Run(new ProcessRequest(SessionProfiles.SshCommand, [])
        {
            CommandLine = $"-T -o BatchMode=yes -o ConnectTimeout=15 {server.Ssh} {SshGitRunner.QuoteArgument(command)}",
            Timeout = CopyTimeout,
        });
        if (!result.Succeeded)
        {
            throw new IOException(result.ErrorLines.LastOrDefault() ?? $"ssh failed ({result.ExitCode}).");
        }
    }

    /// <summary>From one server to another: down into a temporary folder here, then up; the temporary copy is deleted.</summary>
    private void ThroughHere(FileServer from, string source, FileServer to, string target)
    {
        var temp = Path.Combine(Path.GetTempPath(), TempPrefix + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(temp);
        try
        {
            var local = Path.Combine(temp, Path.GetFileName(target));
            sftp.Run(from.Sftp, [$"get -r {Sftp.Quote(source)} {Sftp.Quote(local)}"], CopyTimeout);
            Upload(to, local, target);
        }
        finally
        {
            Directory.Delete(temp, true);
        }
    }
}
