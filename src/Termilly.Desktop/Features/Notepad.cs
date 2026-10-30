using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>The Notepad's files (js/notepad.js): saving a page to a text file, and opening one in a new page.</summary>
internal sealed class NotepadHandler(PageChannel page, IFileDialogs dialogs) : IMessageHandler
{
    /// <summary>The biggest file a page opens: the Notepad is for notes, not logs.</summary>
    private const long MaxBytes = 2 * 1024 * 1024;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.NotepadSave>(SaveAsync);
        router.On<FromPage.NotepadOpen>(m => OpenAsync(m.RequestId));
    }

    private async Task SaveAsync(FromPage.NotepadSave message)
    {
        var file = message.Path;
        if (message.Ask || string.IsNullOrEmpty(file))
        {
            file = await dialogs.PickTextToSaveAsync(FileName(message.Name, file), Folder(file)).ConfigureAwait(false);
            if (file is null)
            {
                page.Post(new ToPage.NotepadSaved(message.RequestId, null));
                return;
            }
        }
        try
        {
            AppPaths.WriteAtomically(file, message.Text);
            page.Post(new ToPage.NotepadSaved(message.RequestId, file));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.NotepadSaved(message.RequestId, null, e.Message));
        }
    }

    private async Task OpenAsync(string? requestId)
    {
        if (await dialogs.PickTextToOpenAsync().ConfigureAwait(false) is not { } file)
        {
            page.Post(new ToPage.NotepadOpened(requestId, null));
            return;
        }
        try
        {
            if (new FileInfo(file).Length > MaxBytes)
            {
                page.Post(new ToPage.NotepadOpened(requestId, null, Error: $"{Path.GetFileName(file)} is over 2 MB, too big for the Notepad."));
                return;
            }
            page.Post(new ToPage.NotepadOpened(requestId, file, await File.ReadAllTextAsync(file).ConfigureAwait(false)));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.NotepadOpened(requestId, null, Error: e.Message));
        }
    }

    /// <summary>The name the save dialog offers: the file's own, else the page's (as a .txt file).</summary>
    private static string FileName(string? name, string? file)
    {
        if (!string.IsNullOrEmpty(file))
        {
            return Path.GetFileName(file);
        }
        var safe = string.Concat((name ?? string.Empty).Split(Path.GetInvalidFileNameChars())).Trim();
        return $"{(safe.Length > 0 ? safe : "Note")}.txt";
    }

    private static string? Folder(string? file) => string.IsNullOrEmpty(file) ? null : Path.GetDirectoryName(file);
}
