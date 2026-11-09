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
            var bytes = await File.ReadAllBytesAsync(file).ConfigureAwait(false);
            if (NotText(file, bytes) is { } why)
            {
                page.Post(new ToPage.NotepadOpened(requestId, null, Error: why));
                return;
            }
            using var reader = new StreamReader(new MemoryStream(bytes), detectEncodingFromByteOrderMarks: true);
            page.Post(new ToPage.NotepadOpened(requestId, file, await reader.ReadToEndAsync().ConfigureAwait(false)));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.NotepadOpened(requestId, null, Error: e.Message));
        }
    }

    /// <summary>The extensions of pictures, said so when one is opened (the Notepad shows text only).</summary>
    private static readonly HashSet<string> PictureExtensions = new(StringComparer.OrdinalIgnoreCase)
    {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".ico", ".tif", ".tiff", ".heic", ".avif", ".svgz",
    };

    /// <summary>UTF-16's byte order mark, its two bytes (FF FE little-endian, FE FF big-endian).</summary>
    private const byte ByteOrderHigh = 0xFF;
    private const byte ByteOrderLow = 0xFE;

    /// <summary>How much of a file is looked at to tell text from anything else.</summary>
    private const int SniffBytes = 8000;

    /// <summary>
    /// Why a file can't be opened as text (a picture, or anything with zero bytes in its start: binary), or null when it
    /// can. A file marked UTF-16 has zero bytes in its text, and is text.
    /// </summary>
    private static string? NotText(string file, byte[] bytes)
    {
        var name = Path.GetFileName(file);
        if (PictureExtensions.Contains(Path.GetExtension(file)))
        {
            return $"{name} is an image. The Notepad opens text files only.";
        }
        var utf16 = bytes.Length >= 2 && ((bytes[0] == ByteOrderHigh && bytes[1] == ByteOrderLow) || (bytes[0] == ByteOrderLow && bytes[1] == ByteOrderHigh));
        return !utf16 && Array.IndexOf(bytes, (byte)0, 0, Math.Min(bytes.Length, SniffBytes)) >= 0
            ? $"{name} isn't a text file. The Notepad opens text files only."
            : null;
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
