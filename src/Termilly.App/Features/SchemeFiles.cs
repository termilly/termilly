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
/// Importing a colour scheme from a file (Settings › Appearance › Theme, js/themeimport.js): the host's dialog picks
/// it and its text goes to the page, which reads the scheme out of it.
/// </summary>
internal sealed class SchemeFileHandler(PageChannel page, IFileDialogs dialogs) : IMessageHandler
{
    public void Register(MessageRouter router) => router.On<FromPage.SchemeOpen>(m => OpenAsync(m.RequestId));

    private async Task OpenAsync(string? requestId)
    {
        if (await dialogs.PickSchemeToOpenAsync().ConfigureAwait(false) is not { } file)
        {
            page.Post(new ToPage.SchemeOpened(requestId, null));
            return;
        }
        var name = Path.GetFileName(file);
        try
        {
            // Read one byte past the limit, so a file that's bigger (or grows while read) is told apart without reading it all.
            var bytes = new byte[CustomThemeLimits.MaxFileBytes + 1];
            int read;
            await using (var stream = File.OpenRead(file))
            {
                read = await stream.ReadAtLeastAsync(bytes, bytes.Length, throwOnEndOfStream: false).ConfigureAwait(false);
            }
            if (read > CustomThemeLimits.MaxFileBytes)
            {
                page.Post(new ToPage.SchemeOpened(requestId, name, Error: $"{name} is too big to be a colour scheme."));
                return;
            }
            using var reader = new StreamReader(new MemoryStream(bytes, 0, read), detectEncodingFromByteOrderMarks: true);
            page.Post(new ToPage.SchemeOpened(requestId, name, await reader.ReadToEndAsync().ConfigureAwait(false)));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.SchemeOpened(requestId, name, Error: e.Message));
        }
    }
}
