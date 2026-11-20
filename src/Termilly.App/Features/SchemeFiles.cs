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
    /// <summary>The biggest file read: a scheme is a few kilobytes; a whole Windows Terminal settings file fits too.</summary>
    private const long MaxBytes = 512 * 1024;

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
            if (new FileInfo(file).Length > MaxBytes)
            {
                page.Post(new ToPage.SchemeOpened(requestId, name, Error: $"{name} is too big to be a colour scheme."));
                return;
            }
            page.Post(new ToPage.SchemeOpened(requestId, name, await File.ReadAllTextAsync(file).ConfigureAwait(false)));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.SchemeOpened(requestId, name, Error: e.Message));
        }
    }
}
