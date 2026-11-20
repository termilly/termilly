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
        }
        page.Post(await ReadAllAsync(requestId, paths, root).ConfigureAwait(false));
    }

    /// <summary>A folder's files, and its folders' a few levels down, at most one past the limit (so it's seen).</summary>
    internal static IReadOnlyList<string> FilesIn(string root) =>
        [.. Directory.EnumerateFiles(root, "*", new EnumerationOptions
        {
            RecurseSubdirectories = true, MaxRecursionDepth = CustomThemeLimits.FolderDepth, IgnoreInaccessible = true,
        }).Take(CustomThemeLimits.MaxFiles + 1)];

    /// <summary>The files' text, each named by its path under the folder (or its file name), within the limits.</summary>
    internal static async Task<ToPage.SchemeOpened> ReadAllAsync(string? requestId, IReadOnlyList<string> paths, string? root)
    {
        var files = new List<SchemeFileText>();
        long total = 0;
        foreach (var path in paths.Take(CustomThemeLimits.MaxFiles))
        {
            if (await ReadBoundedAsync(path).ConfigureAwait(false) is not { } text || total + text.Length > CustomThemeLimits.MaxTotalBytes)
            {
                continue;
            }
            total += text.Length;
            files.Add(new SchemeFileText(root is null ? Path.GetFileName(path) : Path.GetRelativePath(root, path), text));
        }
        return new ToPage.SchemeOpened(requestId, files, paths.Count - files.Count);
    }

    /// <summary>A file's text, or null when it's too big or can't be read.</summary>
    private static async Task<string?> ReadBoundedAsync(string path)
    {
        try
        {
            // Read one byte past the limit, so a file that's bigger (or grows while read) is told apart without reading it all.
            var bytes = new byte[CustomThemeLimits.MaxFileBytes + 1];
            int read;
            await using (var stream = File.OpenRead(path))
            {
                read = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false).ConfigureAwait(false);
            }
            if (read > CustomThemeLimits.MaxFileBytes)
            {
                return null;
            }
            using var reader = new StreamReader(new MemoryStream(bytes, 0, read), detectEncodingFromByteOrderMarks: true);
            return await reader.ReadToEndAsync().ConfigureAwait(false);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return null;
        }
    }
}
