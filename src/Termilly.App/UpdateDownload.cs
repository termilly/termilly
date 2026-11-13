using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A download that couldn't give a file fit to run; its message is said to the user as it is.</summary>
internal sealed class UpdateDownloadException(string message, Exception? inner = null) : IOException(message, inner);

/// <summary>
/// Downloads an update's installer when the user asks for it (Settings never start one), into a folder of this
/// user's own. The file is hashed as it arrives and kept only if its SHA-256 is the one the signed manifest gives, so
/// a file that was changed on the way, or on the server, is never run; a cancelled or failed download leaves nothing.
/// </summary>
internal sealed class UpdateDownload(HttpClient http, string folder)
{
    /// <summary>The installers' folder: in the user's temp folder, so it's theirs alone and Windows cleans it.</summary>
    public static string DefaultFolder => Path.Combine(Path.GetTempPath(), Product.Name + "-update");

    /// <summary>Long enough for the full Windows installer on a slow line; the user can cancel any time.</summary>
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(30);

    /// <summary>The app's downloader, into <see cref="DefaultFolder"/>.</summary>
    public static UpdateDownload Create() => new(new HttpClient { Timeout = Timeout }, DefaultFolder);

    /// <summary>A file still arriving has this on its name, so nothing takes it for a finished one.</summary>
    private const string PartSuffix = ".part";
    private const int BufferSize = 81920;
    private const int Percent = 100;

    /// <summary>
    /// Downloads <paramref name="package"/>, saying how far it got in percent (only when that changes), and answers
    /// the file's path once its SHA-256 matches. Throws <see cref="UpdateDownloadException"/> when it can't, and
    /// <see cref="OperationCanceledException"/> when <paramref name="cancel"/> stopped it.
    /// </summary>
    public async Task<string> DownloadAsync(UpdatePackage package, IProgress<int> progress, CancellationToken cancel)
    {
        if (!UpdateCheck.IsAllowed(package.Url) || package.FileName.Length == 0)
        {
            throw new UpdateDownloadException("The update's address isn't one Termilly downloads from.");
        }
        Clear();
        Directory.CreateDirectory(folder);
        var file = Path.Combine(folder, package.FileName);
        var part = file + PartSuffix;
        try
        {
            using var response = await http.GetAsync(package.Url, HttpCompletionOption.ResponseHeadersRead, cancel).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            var hash = await SaveAsync(response.Content, part, progress, cancel).ConfigureAwait(false);
            if (!Matches(hash, package.Sha256))
            {
                throw new UpdateDownloadException("The downloaded update isn't the one Termilly expected, so it wasn't kept. Try again later.");
            }
            File.Move(part, file, overwrite: true);
            return file;
        }
        catch (HttpRequestException e)
        {
            Delete(part);
            throw new UpdateDownloadException($"Couldn't download the update: {e.Message}", e);
        }
        catch
        {
            Delete(part);
            throw;
        }
    }

    /// <summary>Whether <paramref name="file"/> is still the one downloaded: checked again just before it's run.</summary>
    public static bool IsIntact(string file, string sha256)
    {
        try
        {
            using var stream = File.OpenRead(file);
            return Matches(SHA256.HashData(stream), sha256);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            return false;
        }
    }

    /// <summary>Removes installers left from an earlier update (and a download cut short).</summary>
    public void Clear()
    {
        try
        {
            if (Directory.Exists(folder))
            {
                Directory.Delete(folder, recursive: true);
            }
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // An installer still running from there keeps its file: the next update clears it.
        }
    }

    private static async Task<byte[]> SaveAsync(HttpContent content, string part, IProgress<int> progress, CancellationToken cancel)
    {
        var total = content.Headers.ContentLength;
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        await using var input = await content.ReadAsStreamAsync(cancel).ConfigureAwait(false);
        await using var output = new FileStream(part, FileMode.Create, FileAccess.Write, FileShare.None, BufferSize, useAsync: true);
        var buffer = new byte[BufferSize];
        long received = 0;
        var reported = -1;
        int read;
        while ((read = await input.ReadAsync(buffer, cancel).ConfigureAwait(false)) > 0)
        {
            hash.AppendData(buffer, 0, read);
            await output.WriteAsync(buffer.AsMemory(0, read), cancel).ConfigureAwait(false);
            received += read;
            var percent = total is > 0 ? (int)Math.Min(Percent, received * Percent / total.Value) : 0;
            if (percent != reported)
            {
                reported = percent;
                progress.Report(percent);
            }
        }
        return hash.GetHashAndReset();
    }

    private static bool Matches(byte[] hash, string sha256) =>
        Convert.ToHexString(hash).Equals(sha256, StringComparison.OrdinalIgnoreCase);

    private static void Delete(string file)
    {
        try
        {
            File.Delete(file);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // Clear() takes it next time.
        }
    }
}
