using System.ComponentModel;
using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The Files side panel (js/filepanel.js): the folders of a terminal, on its server over SFTP (Sftp.cs) for an SSH
/// terminal, else on this machine (LocalFiles.cs). Listing, file operations, and copying files in (uploads, on a
/// server) and out (downloads).
/// </summary>
internal sealed class FilesHandler(PageChannel page, Sftp sftp, TerminalSessions terminals, IFileDialogs dialogs, IDesktopShell desktop) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.FilesList>(m => Task.Run(() => List(m.Id, m.RequestId, m.Path)));
        router.On<FromPage.FilesOp>(m => Task.Run(() => Operate(m)));
        router.On<FromPage.FilesPut>((m, files) => Task.Run(() => CopyIn(m.Id, m.RequestId, m.Dir, files ?? m.Paths ?? [])));
        router.On<FromPage.FilesPick>(m => PickAndCopyInAsync(m.Id, m.RequestId, m.Dir));
        router.On<FromPage.FilesGetTo>(m => PickAndDownloadAsync(m.Id, m.RequestId, m.Path));
    }

    /// <summary>Where downloads go: the user's Downloads folder (TERMILLY_DOWNLOAD_DIR overrides it, for tests).</summary>
    private string Downloads =>
        Environment.GetEnvironmentVariable("TERMILLY_DOWNLOAD_DIR") is { Length: > 0 } dir ? dir : desktop.DownloadsFolder;

    /// <summary>sftp's arguments for an SSH terminal's server; null for a terminal whose files are on this machine.</summary>
    private string? ServerOf(string terminal) => terminals.ProfileOf(terminal) is { } profile ? Sftp.ArgumentsFor(profile.CommandLine) : null;

    private void List(string terminal, string? requestId, string? path)
    {
        try
        {
            var (listed, entries) = ServerOf(terminal) is { } server ? sftp.List(server, path) : LocalFiles.List(path);
            page.Post(new ToPage.FilesListing(requestId, listed, entries));
        }
        catch (IOException ex)
        {
            page.Post(new ToPage.FilesListingFailed(requestId, ex.Message));
        }
    }

    private void Operate(FromPage.FilesOp m)
    {
        try
        {
            var path = m.Path ?? throw new IOException("No file given.");
            var local = ServerOf(m.Id) is { } server ? OnServer(server, m.Op, path, m.To) : Here(m.Op, path, m.To);
            page.Post(new ToPage.FilesDone(m.RequestId, local));
        }
        catch (Exception ex) when (ex is IOException or Win32Exception)
        {
            page.Post(new ToPage.FilesFailed(m.RequestId, ex.Message));
        }
    }

    /// <summary>Runs one file operation on the server; a download's local path, else null.</summary>
    private string? OnServer(string server, string? op, string remote, string? to)
    {
        switch (op)
        {
            case FileOperations.Get:
                var folder = to ?? Downloads;
                Directory.CreateDirectory(folder);
                var local = LocalFiles.FreeName(Path.Combine(folder, Path.GetFileName(remote)));
                sftp.Run(server, [$"get {Sftp.Quote(remote)} {Sftp.Quote(local)}"]);
                return local;
            case FileOperations.Remove or FileOperations.RemoveDirectory or FileOperations.MakeDirectory:
                sftp.Run(server, [$"{op} {Sftp.Quote(remote)}"]);
                return null;
            case FileOperations.Rename:
                sftp.Run(server, [$"rename {Sftp.Quote(remote)} {Sftp.Quote(to ?? remote)}"]);
                return null;
            default:
                throw new IOException("Unknown file operation.");
        }
    }

    /// <summary>Runs one file operation on this machine.</summary>
    private string? Here(string? op, string path, string? to)
    {
        switch (op)
        {
            case FileOperations.Rename:
                LocalFiles.Rename(path, to ?? path);
                break;
            case FileOperations.MakeDirectory:
                LocalFiles.MakeDirectory(path);
                break;
            case FileOperations.Remove or FileOperations.RemoveDirectory:
                desktop.Trash(path);
                break;
            case FileOperations.Open:
                desktop.OpenFile(path);
                break;
            case FileOperations.Reveal:
                desktop.ShowPath(path);
                break;
            default:
                throw new IOException("Unknown file operation.");
        }
        return null;
    }

    /// <summary>Copies files dropped or picked in the panel into a folder (uploads them, on a server), one at a time, reporting each.</summary>
    private void CopyIn(string terminal, string? requestId, string? directory, IReadOnlyList<string> files)
    {
        var server = ServerOf(terminal);
        foreach (var file in files)
        {
            try
            {
                if (directory is null)
                {
                    throw new IOException("No folder to copy to.");
                }
                if (!File.Exists(file))
                {
                    throw new IOException("Only files can be copied, not folders.");
                }
                if (server is null)
                {
                    LocalFiles.CopyInto(file, directory);
                }
                else
                {
                    sftp.Run(server, [$"put {Sftp.Quote(file)} {Sftp.Quote(Sftp.Join(directory, Path.GetFileName(file)))}"]);
                }
                page.Post(new ToPage.FilesCopied(requestId, Path.GetFileName(file)));
            }
            catch (IOException ex)
            {
                page.Post(new ToPage.FilesCopyFailed(requestId, Path.GetFileName(file), ex.Message));
            }
        }
    }

    /// <summary>The panel's Upload button where the host picks the files: the page hears which, then each one's result.</summary>
    private async Task PickAndCopyInAsync(string terminal, string? requestId, string? directory)
    {
        var files = await dialogs.PickFilesAsync("Upload files").ConfigureAwait(false);
        if (files.Count > 0)
        {
            page.Post(new ToPage.FilesQueued(requestId, files.Select(Path.GetFileName)));
            _ = Task.Run(() => CopyIn(terminal, requestId, directory, files));
        }
    }

    /// <summary>"Download to": the folder picked, then the download into it, which the page sees queued and done.</summary>
    private async Task PickAndDownloadAsync(string terminal, string? requestId, string? remote)
    {
        if (remote is null || ServerOf(terminal) is not { } server)
        {
            return;
        }
        var folder = await dialogs.PickFolderAsync("Download to", Downloads).ConfigureAwait(false);
        if (folder is null)
        {
            return;
        }
        page.Post(new ToPage.FilesQueued(requestId, [Path.GetFileName(remote)]));
        _ = Task.Run(() =>
        {
            try
            {
                page.Post(new ToPage.FilesDone(requestId, OnServer(server, FileOperations.Get, remote, folder)));
            }
            catch (IOException ex)
            {
                page.Post(new ToPage.FilesFailed(requestId, ex.Message));
            }
        });
    }
}
