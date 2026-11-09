using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Features;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Phone;

/// <summary>
/// What another Termilly computer's Copy to asks of this one, over the phone server (Features/RemotePcFiles.cs is the
/// other side): a terminal's folders, one folder's listing, a new folder, and items put into a folder. Each item comes
/// as a zip of itself (a file, or a folder with what's in it), unpacked here and copied in as a Copy to between this
/// PC's own terminals is, so a terminal on a server here takes it too.
/// </summary>
internal static class PcFiles
{
    public const string Tree = "/api/files/tree";
    public const string List = "/api/files/list";
    public const string MakeFolder = "/api/files/mkdir";
    public const string Put = "/api/files/put";
    /// <summary>What an item is zipped to, in a temporary folder on each side.</summary>
    public const string ItemZip = "item.zip";

    /// <summary>The fields of the JSON requests and answers.</summary>
    public static class Fields
    {
        public const string Pane = "pane";
        public const string Paths = "paths";
        public const string Files = "files";
        public const string Path = "path";
        public const string Error = "error";
    }

    /// <summary>An upload's headers: where it goes (the folder and the name, base64 so any characters pass).</summary>
    public static class Headers
    {
        public const string Pane = "X-Termilly-Pane";
        public const string Dir = "X-Termilly-Dir";
        public const string Name = "X-Termilly-Name";
        public const string Length = "Content-Length";
    }

    public static string Encode(string text) => Convert.ToBase64String(Encoding.UTF8.GetBytes(text));

    public static string? Decode(string? text)
    {
        try
        {
            return text is null ? null : Encoding.UTF8.GetString(Convert.FromBase64String(text));
        }
        catch (FormatException)
        {
            return null;
        }
    }
}

/// <summary>This computer's side of <see cref="PcFiles"/>: only for a paired device, and only while it may type here.</summary>
internal sealed class PcFilesApi(FilesHandler files, ISettingsStore settings)
{
    /// <summary>The largest item taken (zipped).</summary>
    private const long MaxUpload = 64L << 30;
    /// <summary>An upload that sends nothing for this long is dropped.</summary>
    private static readonly TimeSpan Idle = TimeSpan.FromMinutes(1);
    private const int Chunk = 81920;
    private const string TempPrefix = "termilly-in-";
    private const string Refused = "Copying files here is off: on that computer, Settings › Remote › Allow typing.";

    public static bool Handles(string path) => path is PcFiles.Tree or PcFiles.List or PcFiles.MakeFolder;

    /// <summary>Answers a folders, listing or new-folder request (the device is paired: PhoneServer checked).</summary>
    public PhoneReply Answer(PhoneRequest request)
    {
        if (!settings.Current.Phone.AllowTyping)
        {
            return Error(Refused);
        }
        JsonObject? body;
        try
        {
            body = JsonNode.Parse(request.Body) as JsonObject;
        }
        catch (JsonException)
        {
            body = null;
        }
        var pane = body?[PcFiles.Fields.Pane].AsText();
        if (body is null || string.IsNullOrEmpty(pane))
        {
            return new(HttpStatusCode.BadRequest, MediaTypes.PlainText, []);
        }
        var path = body[PcFiles.Fields.Path].AsText();
        return request.Path switch
        {
            PcFiles.Tree => Json(files.TreeJson(pane, null, (body[PcFiles.Fields.Paths] as JsonArray)?.Select(p => p.AsText() ?? "").ToList() ?? [],
                body[PcFiles.Fields.Files].AsBool() ?? false)),
            PcFiles.List => Json(files.ListingJson(pane, null, path)),
            PcFiles.MakeFolder => files.MakeFolder(pane, path ?? "") is { } error ? Error(error) : Json("{}"),
            _ => new(HttpStatusCode.NotFound, MediaTypes.PlainText, []),
        };
    }

    /// <summary>
    /// Takes an item put into a folder: the zip of it (what <paramref name="received"/> holds of it already, then the
    /// rest from the connection), unpacked in a temporary folder and copied in under its name.
    /// </summary>
    public async Task<PhoneReply> UploadAsync(PhoneRequest request, Stream stream, CancellationToken cancel)
    {
        var headers = request.Headers;
        var (pane, dir, name) = (headers.GetValueOrDefault(PcFiles.Headers.Pane), PcFiles.Decode(headers.GetValueOrDefault(PcFiles.Headers.Dir)),
            PcFiles.Decode(headers.GetValueOrDefault(PcFiles.Headers.Name)));
        if (!settings.Current.Phone.AllowTyping)
        {
            return Error(Refused);
        }
        if (string.IsNullOrEmpty(pane) || dir is null || name is null || !FilesHandler.IsFileName(name) ||
            !long.TryParse(headers.GetValueOrDefault(PcFiles.Headers.Length), out var length) || length is < 0 or > MaxUpload)
        {
            return new(HttpStatusCode.BadRequest, MediaTypes.PlainText, []);
        }
        var temp = Directory.CreateTempSubdirectory(TempPrefix).FullName;
        try
        {
            var zip = Path.Combine(temp, PcFiles.ItemZip);
            await Receive(request.Body, stream, length, zip, cancel).ConfigureAwait(false);
            var unpacked = Path.Combine(temp, "item");
            ZipFile.ExtractToDirectory(zip, unpacked);
            var item = Path.Combine(unpacked, name);
            if (!File.Exists(item) && !Directory.Exists(item))
            {
                return Error("The copy came without the item.");
            }
            return await Task.Run(() => files.CopyHere(item, pane, dir, name), cancel).ConfigureAwait(false) is { } error ? Error(error) : Json("{}");
        }
        catch (Exception e) when (e is IOException or InvalidDataException or UnauthorizedAccessException)
        {
            return Error(e.Message);
        }
        finally
        {
            Storage.Try(() => Directory.Delete(temp, recursive: true));
        }
    }

    /// <summary>Writes the body to a file: the part read with the head, then the rest, each read given a minute.</summary>
    private static async Task Receive(byte[] start, Stream stream, long length, string file, CancellationToken cancel)
    {
        await using var output = File.Create(file);
        var have = Math.Min(start.Length, length);
        await output.WriteAsync(start.AsMemory(0, (int)have), cancel).ConfigureAwait(false);
        var buffer = new byte[Chunk];
        while (have < length)
        {
            using var idle = CancellationTokenSource.CreateLinkedTokenSource(cancel);
            idle.CancelAfter(Idle);
            var read = await stream.ReadAsync(buffer.AsMemory(0, (int)Math.Min(buffer.Length, length - have)), idle.Token).ConfigureAwait(false);
            if (read == 0)
            {
                throw new IOException("The copy stopped before it was all sent.");
            }
            await output.WriteAsync(buffer.AsMemory(0, read), cancel).ConfigureAwait(false);
            have += read;
        }
    }

    internal static PhoneReply Json(string json) => new(HttpStatusCode.OK, MediaTypes.Utf8(MediaTypes.Json), Encoding.UTF8.GetBytes(json));

    internal static PhoneReply Error(string message) =>
        new(HttpStatusCode.Conflict, MediaTypes.Utf8(MediaTypes.Json), Encoding.UTF8.GetBytes(new JsonObject { [PcFiles.Fields.Error] = message }.ToJsonString()));
}
