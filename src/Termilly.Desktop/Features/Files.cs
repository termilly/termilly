using System.ComponentModel;
using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The Files side panel (js/filepanel.js): the folders of a terminal, on its server over SFTP (Sftp.cs) for an SSH
/// terminal, else on this machine (LocalFiles.cs). Listing, file operations, and copying files in (uploads, on a
/// server) and out (downloads), and "Copy to" another terminal's folder (FileCopies.cs).
/// </summary>
internal sealed class FilesHandler(
    PageChannel page, Sftp sftp, FileCopies copies, FolderTree tree, TerminalSessions terminals, IFileDialogs dialogs, IDesktopShell desktop)
    : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.FilesList>(m => Task.Run(() => List(m.Id, m.RequestId, m.Path)));
        router.On<FromPage.FilesTree>(m => Task.Run(() => Tree(m.Id, m.RequestId, m.Paths ?? [], m.Files)));
        router.On<FromPage.FilesOp>(m => Task.Run(() => Operate(m)));
        router.On<FromPage.FilesPut>((m, files) => Task.Run(() => CopyIn(m.Id, m.RequestId, m.Dir, files ?? m.Paths ?? [])));
        router.On<FromPage.FilesPick>(m => PickAndCopyInAsync(m.Id, m.RequestId, m.Dir));
        router.On<FromPage.FilesGetTo>(m => PickAndDownloadAsync(m.Id, m.RequestId, m.Paths ?? []));
        router.On<FromPage.FilesCopyTo>(m => Task.Run(() => CopyTo(m)));
    }

    /// <summary>Where downloads go: the user's Downloads folder (TERMILLY_DOWNLOAD_DIR overrides it, for tests).</summary>
    private string Downloads =>
        Environment.GetEnvironmentVariable("TERMILLY_DOWNLOAD_DIR") is { Length: > 0 } dir ? dir : desktop.DownloadsFolder;

    /// <summary>An SSH terminal's server; null for a terminal whose files are on this machine.</summary>
    private FileServer? PlaceOf(string terminal) =>
        terminals.ProfileOf(terminal) is { } profile && Sftp.ArgumentsFor(profile.CommandLine) is { } arguments
            ? new(arguments, profile.CommandLine[(SessionProfiles.SshCommand.Length + 1)..])
            : null;

    /// <summary>sftp's arguments for an SSH terminal's server; null for a terminal whose files are on this machine.</summary>
    private string? ServerOf(string terminal) => PlaceOf(terminal)?.Sftp;

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

    /// <summary>A tree's folders (and files) in each folder asked for (disk or ssh work, so off the UI thread).</summary>
    private void Tree(string terminal, string? requestId, IReadOnlyList<string> paths, bool files)
    {
        try
        {
            var branches = PlaceOf(terminal) is { } server ? tree.OnServer(server, paths, files) : FolderTree.Here(paths, files);
            page.Post(new ToPage.FilesTree(requestId, branches));
        }
        catch (IOException ex)
        {
            page.Post(new ToPage.FilesTree(requestId, [], ex.Message));
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
                sftp.Run(server, [$"get -r {Sftp.Quote(remote)} {Sftp.Quote(local)}"]);
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

    /// <summary>"Download to": the folder picked, then the downloads into it, which the page sees queued and each done.</summary>
    private async Task PickAndDownloadAsync(string terminal, string? requestId, IReadOnlyList<string> remotes)
    {
        if (remotes.Count == 0 || ServerOf(terminal) is not { } server)
        {
            return;
        }
        var folder = await dialogs.PickFolderAsync("Download to", Downloads).ConfigureAwait(false);
        if (folder is null)
        {
            return;
        }
        page.Post(new ToPage.FilesQueued(requestId, remotes.Select(Sftp.NameOf)));
        _ = Task.Run(() =>
        {
            foreach (var remote in remotes)
            {
                try
                {
                    page.Post(new ToPage.FilesSaved(requestId, Sftp.NameOf(remote), OnServer(server, FileOperations.Get, remote, folder)!));
                }
                catch (IOException ex)
                {
                    page.Post(new ToPage.FilesCopyFailed(requestId, Sftp.NameOf(remote), ex.Message));
                }
            }
        });
    }

    /// <summary>"Copy to": each item into the folder of the other terminal (here or on its server), reported as it's done.</summary>
    private void CopyTo(FromPage.FilesCopyTo m)
    {
        var (from, to) = (PlaceOf(m.Id), PlaceOf(m.To));
        foreach (var item in m.Items ?? [])
        {
            try
            {
                var dir = m.Dir ?? throw new IOException("No folder to copy to.");
                // A name, not a path: nothing lands outside the folder picked.
                if (item.Name.Length == 0 || item.Name.IndexOfAny(['/', '\\']) >= 0 || item.Name is "." or "..")
                {
                    throw new IOException("Not a file name.");
                }
                copies.Copy(from, item.Path, to, to is null ? Path.Combine(dir, item.Name) : Sftp.Join(dir, item.Name));
                page.Post(new ToPage.FilesCopied(m.RequestId, item.Name));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                page.Post(new ToPage.FilesCopyFailed(m.RequestId, item.Name, ex.Message));
            }
        }
    }
}
