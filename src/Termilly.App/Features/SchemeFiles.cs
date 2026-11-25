using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>The kinds of file other terminals keep their colour schemes in, for the import dialog's file types.</summary>
internal static class SchemeFiles
{
    /// <summary>iTerm2, Windows Terminal, Alacritty, Kitty and Warp; Ghostty's themes have no extension (All files).</summary>
    public static readonly string[] Extensions = [".itermcolors", ".json", ".toml", ".conf", ".yaml", ".yml"];
}

/// <summary>
/// Importing colour schemes from files (Settings › Appearance › Theme, js/themeimport.js): the host's dialog picks
/// some files, or a folder whose files (and its folders', a few levels down) are all read; their text goes to the
/// page, which reads the schemes out of them. Files too big, unreadable or past the limits are left out and counted.
/// </summary>
internal sealed class SchemeFileHandler(PageChannel page, IFileDialogs dialogs) : IMessageHandler
{
    public void Register(MessageRouter router) => router.On<FromPage.SchemeOpen>(m => OpenAsync(m.RequestId, m.Folder));

    private async Task OpenAsync(string? requestId, bool folder)
    {
        IReadOnlyList<string> paths;
        string? root = null;
        if (folder)
        {
            var home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            root = await dialogs.PickFolderAsync("Import colour schemes from a folder", home).ConfigureAwait(false);
            if (root is null)
            {
                page.Post(new ToPage.SchemeOpened(requestId));
                return;
            }
            try
            {
                paths = FilesIn(root);
            }
            catch (Exception e) when (Storage.IsFileError(e))
            {
                page.Post(new ToPage.SchemeOpened(requestId, Error: e.Message));
                return;
            }
        }
        else
        {
            paths = await dialogs.PickSchemesToOpenAsync().ConfigureAwait(false);
            if (paths.Count == 0)
            {
                page.Post(new ToPage.SchemeOpened(requestId)); // cancelled: the dialog keeps what it shows
                return;
            }
        }
        page.Post(await ReadAllAsync(requestId, paths, root).ConfigureAwait(false));
    }

    /// <summary>A folder's files, and its folders' a few levels down, at most one past the limit (so it's seen).</summary>
    internal static IReadOnlyList<string> FilesIn(string root) =>
        [.. Directory.EnumerateFiles(root, "*", new EnumerationOptions
        {
            RecurseSubdirectories = true, MaxRecursionDepth = CustomThemeLimits.FolderDepth, IgnoreInaccessible = true,
        }).Take(CustomThemeLimits.MaxFiles + 1)];

    /// <summary>
    /// The files' text, each named by its file name (and placed by its path under the folder), within the limits: a file
    /// bigger than what's left of the total is left out without reading it whole.
    /// </summary>
    internal static async Task<ToPage.SchemeOpened> ReadAllAsync(string? requestId, IReadOnlyList<string> paths, string? root)
    {
        var files = new List<SchemeFileText>();
        long left = CustomThemeLimits.MaxTotalBytes;
        foreach (var path in paths.Take(CustomThemeLimits.MaxFiles))
        {
            if (await ReadBoundedAsync(path, (int)Math.Min(CustomThemeLimits.MaxFileBytes, left)).ConfigureAwait(false) is not { } read)
            {
                continue;
            }
            left -= read.Bytes;
            files.Add(new SchemeFileText(Path.GetFileName(path), read.Text, root is null ? null : Path.GetRelativePath(root, path)));
        }
        return new ToPage.SchemeOpened(requestId, files, paths.Count - files.Count);
    }

    /// <summary>A file's text and its size in bytes.</summary>
    private sealed record FileRead(string Text, int Bytes);

    /// <summary>A file's text, or null when it's bigger than the limit (in bytes) or can't be read.</summary>
    private static async Task<FileRead?> ReadBoundedAsync(string path, int limit)
    {
        try
        {
            // Read one byte past the limit, so a file that's bigger (or grows while read) is told apart without reading it all.
            var bytes = new byte[limit + 1];
            int read;
            await using (var stream = File.OpenRead(path))
            {
                read = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false).ConfigureAwait(false);
            }
            if (read > limit)
            {
                return null;
            }
            using var reader = new StreamReader(new MemoryStream(bytes, 0, read), detectEncodingFromByteOrderMarks: true);
            return new FileRead(await reader.ReadToEndAsync().ConfigureAwait(false), read);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null;
        }
    }
}
