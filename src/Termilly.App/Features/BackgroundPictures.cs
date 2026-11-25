using System.IO;
using System.Security.Cryptography;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The pictures shown behind the terminals (Settings › Appearance › Background, a workspace's Background): each one
/// picked is copied into the backgrounds folder under a name made from its content, so it stays when the original is
/// moved, and the same picture picked twice is kept once.
/// </summary>
internal static class BackgroundPictures
{
    public const string FolderName = "backgrounds";

    /// <summary>The kinds of picture the page's browser shows on every system, and what each is served as.</summary>
    public static readonly IReadOnlyDictionary<string, string> Types = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        [MediaTypes.Extensions.Png] = MediaTypes.Png, [MediaTypes.Extensions.Jpg] = MediaTypes.Jpeg,
        [MediaTypes.Extensions.Jpeg] = MediaTypes.Jpeg, [MediaTypes.Extensions.Webp] = MediaTypes.Webp,
        [MediaTypes.Extensions.Gif] = MediaTypes.Gif, [MediaTypes.Extensions.Bmp] = MediaTypes.Bmp,
    };

    /// <summary>The biggest picture kept: a large photo fits, a mistaken video doesn't.</summary>
    public const long MaxBytes = 40L * 1024 * 1024;

    /// <summary>A picture being copied in, until it's whole (never one of the folder's names).</summary>
    private const string PartialSuffix = ".partial";

    /// <summary>How many hex digits of the content's hash name a picture: enough that two never meet.</summary>
    private const int NameDigits = 16;

    /// <summary>The folder the pictures are kept in, in the app's data folder.</summary>
    public static string Folder => Path.Combine(AppPaths.DataDirectory, FolderName);

    /// <summary>A name this folder gives: hex digits and a picture's extension, nothing that could reach outside it.</summary>
    public static bool IsName(string? name) =>
        name is { Length: > NameDigits } && Types.ContainsKey(Path.GetExtension(name))
        && Path.GetFileNameWithoutExtension(name) is { Length: NameDigits } stem && stem.All(char.IsAsciiHexDigitLower);

    /// <summary>The file a name stands for, or null when it isn't one of this folder's names or isn't there.</summary>
    public static string? FileFor(string folder, string name)
    {
        if (!IsName(name))
        {
            return null;
        }
        var file = Path.Combine(folder, name);
        // Not a link: one named like a picture must not lead outside the folder.
        return File.Exists(file) && new FileInfo(file).LinkTarget is null ? file : null;
    }

    /// <summary>Copies a picture into <paramref name="folder"/> and gives the name it's kept under.</summary>
    /// <exception cref="InvalidDataException">Not a picture the page can show, or too big.</exception>
    public static async Task<string> KeepAsync(string path, string folder)
    {
        var extension = Path.GetExtension(path).ToLowerInvariant();
        if (!Types.ContainsKey(extension))
        {
            throw new InvalidDataException("That isn’t a picture Termilly can show: PNG, JPEG, WebP, GIF or BMP.");
        }
        var size = new FileInfo(path).Length;
        if (size > MaxBytes)
        {
            throw new InvalidDataException($"That picture is too big: up to {MaxBytes / (1024 * 1024)} MB.");
        }
        byte[] hash;
        await using (var source = File.OpenRead(path))
        {
            hash = await SHA256.HashDataAsync(source).ConfigureAwait(false);
        }
        var name = Convert.ToHexStringLower(hash)[..NameDigits] + extension;
        Directory.CreateDirectory(folder);
        var target = Path.Combine(folder, name);
        if (!File.Exists(target))
        {
            // Copied beside it first, then renamed: a copy cut short never stands as the picture.
            var partial = $"{target}.{Guid.NewGuid():N}{PartialSuffix}"; // its own, if the same picture is picked twice at once
            File.Copy(path, partial, overwrite: true);
            try
            {
                File.Move(partial, target);
            }
            catch (IOException) when (File.Exists(target))
            {
                File.Delete(partial); // the same picture, kept meanwhile
            }
        }
        return name;
    }
}

/// <summary>Picks a background picture for the page and tells it what the window's background can be here.</summary>
internal sealed class BackgroundHandler(PageChannel page, IFileDialogs dialogs, IWindowBackdrop backdrop) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.BackgroundPick>(m => PickAsync(m.RequestId));
        router.On<FromPage.BackgroundInfo>(m => page.Post(new ToPage.BackgroundInfo(m.RequestId, backdrop.Effects, backdrop.PictureBase)));
    }

    private async Task PickAsync(string? requestId)
    {
        if (await dialogs.PickPictureToOpenAsync().ConfigureAwait(false) is not { } path)
        {
            page.Post(new ToPage.BackgroundPicked(requestId)); // cancelled
            return;
        }
        try
        {
            page.Post(new ToPage.BackgroundPicked(requestId, await BackgroundPictures.KeepAsync(path, BackgroundPictures.Folder).ConfigureAwait(false)));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is InvalidDataException)
        {
            page.Post(new ToPage.BackgroundPicked(requestId, Error: e.Message));
        }
    }
}
