using System.ComponentModel;
using System.IO;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The Files side panel (js/filepanel.js): the folders of a terminal, on its server over SFTP (Sftp.cs) for an SSH
/// terminal, else on this machine (LocalFiles.cs). Listing, file operations, and copying files in (uploads, on a
/// server) and out (downloads), and "Copy to" another terminal's folder (FileCopies.cs).
/// </summary>
internal sealed class FilesHandler(
    PageChannel page, Sftp sftp, FileCopies copies, FolderTree tree, FileSearch search, TerminalSessions terminals, IFileDialogs dialogs, IDesktopShell desktop,
    RemotePcFiles remotes)
    : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.FilesList>(m => RemotePcFiles.Is(m.Id)
            ? FromComputerAsync(m.Id, m.RequestId, PcFiles.List, new JsonObject { [PcFiles.Fields.Path] = m.Path })
            : Task.Run(() => page.PostJson(ListingJson(m.Id, m.RequestId, m.Path))));
        router.On<FromPage.FilesTree>(m => RemotePcFiles.Is(m.Id)
            ? FromComputerAsync(m.Id, m.RequestId, PcFiles.Tree, new JsonObject { [PcFiles.Fields.Paths] = new JsonArray([.. (m.Paths ?? []).Select(p => (JsonNode?)JsonValue.Create(p))]), [PcFiles.Fields.Files] = m.Files })
            : Task.Run(() => page.PostJson(TreeJson(m.Id, m.RequestId, m.Paths ?? [], m.Files))));
        router.On<FromPage.FilesOp>(m => RemotePcFiles.Is(m.Id) ? MakeFolderThereAsync(m) : Task.Run(() => Operate(m)));
        router.On<FromPage.FilesPut>((m, files) => Task.Run(() => CopyIn(m.Id, m.RequestId, m.Dir, files ?? m.Paths ?? [])));
        router.On<FromPage.FilesPick>(m => PickAndCopyInAsync(m.Id, m.RequestId, m.Dir));
        router.On<FromPage.FilesGetTo>(m => PickAndDownloadAsync(m.Id, m.RequestId, m.Paths ?? []));
        router.On<FromPage.FilesCopyTo>(m => Task.Run(() => CopyTo(m)));
        router.On<FromPage.FilesSearch>(Search);
    }

    /// <summary>The search running (one at a time: a new one, or none, stops it).</summary>
    private CancellationTokenSource? searching;

    /// <summary>Where downloads go: the user's Downloads folder (TERMILLY_DOWNLOAD_DIR overrides it, for tests).</summary>
    private string Downloads =>
        Environment.GetEnvironmentVariable("TERMILLY_DOWNLOAD_DIR") is { Length: > 0 } dir ? dir : desktop.DownloadsFolder;

    /// <summary>An SSH terminal's server; null for a terminal whose files are on this machine.</summary>
    private FileServer? PlaceOf(string terminal) =>
        terminals.ProfileOf(terminal) is { } profile && Sftp.ArgumentsFor(profile.CommandLine) is { } arguments
            ? new(arguments, profile.CommandLine[(SessionProfiles.SshCommand.Length + 1)..])
            : null;

    /// <summary>Whether a terminal's files are on this machine (a copy into its folder takes room on this computer's disk).</summary>
    public bool IsLocal(string terminal) => PlaceOf(terminal) is null;

    /// <summary>sftp's arguments for an SSH terminal's server; null for a terminal whose files are on this machine.</summary>
    private string? ServerOf(string terminal) => PlaceOf(terminal)?.Sftp;

    /// <summary>
    /// A folder's listing, as the page gets it (disk or ssh work, so off the UI thread). Another Termilly computer's
    /// Copy to asks for it too (Phone/PcFilesApi.cs).
    /// </summary>
    public string ListingJson(string terminal, string? requestId, string? path)
    {
        try
        {
            var (listed, entries) = ServerOf(terminal) is { } server ? sftp.List(server, path) : LocalFiles.List(path);
            return HostMessage.Json(new ToPage.FilesListing(requestId, listed, entries), PageChannel.Json);
        }
        catch (IOException ex)
        {
            return HostMessage.Json(new ToPage.FilesListingFailed(requestId, ex.Message), PageChannel.Json);
        }
    }

    /// <summary>A tree's folders (and files) in each folder asked for, as the page gets them; another computer's Copy to too.</summary>
    public string TreeJson(string terminal, string? requestId, IReadOnlyList<string> paths, bool files)
    {
        try
        {
            var branches = PlaceOf(terminal) is { } server ? tree.OnServer(server, paths, files) : FolderTree.Here(paths, files);
            return HostMessage.Json(new ToPage.FilesTree(requestId, branches), PageChannel.Json);
        }
        catch (IOException ex)
        {
            return HostMessage.Json(new ToPage.FilesTree(requestId, [], ex.Message), PageChannel.Json);
        }
    }

    /// <summary>A new folder for another computer's Copy to; the reason it couldn't be made, else null.</summary>
    public string? MakeFolder(string terminal, string path)
    {
        try
        {
            _ = ServerOf(terminal) is { } server ? OnServer(server, FileOperations.MakeDirectory, path, null) : Here(FileOperations.MakeDirectory, path, null);
            return null;
        }
        catch (Exception ex) when (ex is IOException or Win32Exception or UnauthorizedAccessException)
        {
            return ex.Message;
        }
    }

    /// <summary>
    /// Copies a file or folder of this PC into a terminal's folder (here or on its server) under a name: another
    /// computer's Copy to, unpacked. The reason it couldn't, else null.
    /// </summary>
    public string? CopyHere(string local, string terminal, string dir, string name)
    {
        try
        {
            var to = PlaceOf(terminal);
            copies.Copy(null, local, to, to is null ? Path.Combine(dir, name) : Sftp.Join(dir, name));
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            return ex.Message;
        }
    }

    /// <summary>A name, not a path: nothing a copy is named lands outside the folder picked.</summary>
    public static bool IsFileName(string name) => name.Length > 0 && name.IndexOfAny(['/', '\\']) < 0 && name is not ("." or "..");

    /// <summary>The answer's field the page matches to its request.</summary>
    private const string RequestIdField = "requestId";

    /// <summary>Another computer's answer about its terminal's folders, passed to the page as if it were this PC's.</summary>
    private async Task FromComputerAsync(string terminal, string? requestId, string path, JsonObject body)
    {
        JsonObject answer;
        try
        {
            answer = await remotes.AskAsync(terminal, path, body).ConfigureAwait(false);
        }
        catch (IOException ex)
        {
            answer = JsonNode.Parse(path == PcFiles.Tree
                ? HostMessage.Json(new ToPage.FilesTree(null, [], ex.Message), PageChannel.Json)
                : HostMessage.Json(new ToPage.FilesListingFailed(null, ex.Message), PageChannel.Json))!.AsObject();
        }
        answer[RequestIdField] = requestId;
        page.PostJson(answer.ToJsonString());
    }

    /// <summary>Copy to's New folder in another computer's terminal (the only file operation there).</summary>
    private async Task MakeFolderThereAsync(FromPage.FilesOp m)
    {
        try
        {
            if (m.Op != FileOperations.MakeDirectory)
            {
                throw new IOException("Only a new folder can be made there.");
            }
            await remotes.AskAsync(m.Id, PcFiles.MakeFolder, new JsonObject { [PcFiles.Fields.Path] = m.Path }).ConfigureAwait(false);
            page.Post(new ToPage.FilesDone(m.RequestId, null));
        }
        catch (IOException ex)
        {
            page.Post(new ToPage.FilesFailed(m.RequestId, ex.Message));
        }
    }

    /// <summary>
    /// One item to another computer's terminal: a server's is fetched here first (into a temporary folder), then it
    /// goes as a zip.
    /// </summary>
    private void ToComputer(FileServer? from, string path, string terminal, string dir, string name)
    {
        if (from is null)
        {
            remotes.PutAsync(terminal, path, dir, name).GetAwaiter().GetResult();
            return;
        }
        var temp = Directory.CreateTempSubdirectory("termilly-fetch-").FullName;
        try
        {
            var local = Path.Combine(temp, name);
            copies.Copy(from, path, null, local);
            remotes.PutAsync(terminal, local, dir, name).GetAwaiter().GetResult();
        }
        finally
        {
            Storage.Try(() => Directory.Delete(temp, recursive: true));
        }
    }

    /// <summary>A search, off the UI thread: what it finds as it goes (a server's at once), then its end.</summary>
    private void Search(FromPage.FilesSearch m)
    {
        var cancel = new CancellationTokenSource();
        Interlocked.Exchange(ref searching, cancel)?.Cancel();
        if (string.IsNullOrWhiteSpace(m.Text) || m.Dir is null)
        {
            return;
        }
        var (id, dir, text, server) = (m.SearchId, m.Dir, m.Text.Trim(), PlaceOf(m.Id));
        _ = Task.Run(() =>
        {
            try
            {
                bool stopped;
                if (server is null)
                {
                    stopped = FileSearch.Here(dir, text, found => page.Post(new ToPage.FilesFound(id, found)), cancel.Token);
                }
                else
                {
                    (var found, stopped) = search.OnServer(server, dir, text, cancel.Token);
                    page.Post(new ToPage.FilesFound(id, found));
                }
                page.Post(new ToPage.FilesFound(id, [], Done: true, Stopped: stopped));
            }
            catch (OperationCanceledException)
            {
                // A newer search took over.
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                page.Post(new ToPage.FilesFound(id, [], Done: true, Error: ex.Message));
            }
        }, CancellationToken.None);
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
        var toComputer = RemotePcFiles.Is(m.To);
        var (from, to) = (PlaceOf(m.Id), toComputer ? null : PlaceOf(m.To));
        foreach (var item in m.Items ?? [])
        {
            try
            {
                var dir = m.Dir ?? throw new IOException("No folder to copy to.");
                if (!IsFileName(item.Name))
                {
                    throw new IOException("Not a file name.");
                }
                if (toComputer)
                {
                    ToComputer(from, item.Path, m.To!, dir, item.Name);
                }
                else
                {
                    copies.Copy(from, item.Path, to, to is null ? Path.Combine(dir, item.Name) : Sftp.Join(dir, item.Name));
                }
                page.Post(new ToPage.FilesCopied(m.RequestId, item.Name));
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                page.Post(new ToPage.FilesCopyFailed(m.RequestId, item.Name, ex.Message));
            }
        }
    }
}
