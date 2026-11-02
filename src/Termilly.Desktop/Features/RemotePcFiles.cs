using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Phone;

namespace Termilly.Desktop.Features;

/// <summary>
/// Copy to a terminal of another Termilly computer (Phone/PcFilesApi.cs is its side). The page names such a terminal
/// "pc:&lt;computer&gt;:&lt;its terminal&gt;"; its folders and listings come from the computer, and each item goes there
/// as a zip of itself. Prompt history asks the computer through it too (Phone/PcPromptsApi.cs).
/// </summary>
internal sealed class RemotePcFiles(RemotePcStore store)
{
    private const string Prefix = "pc:";
    private static readonly TimeSpan AskTimeout = TimeSpan.FromSeconds(30);
    /// <summary>How long one item may take to go (a big folder over Wi-Fi).</summary>
    private static readonly TimeSpan PutTimeout = TimeSpan.FromHours(2);
    private const string TempPrefix = "termilly-out-";
    private const string JsonType = "application/json";

    /// <summary>The id the page gives a computer's terminal.</summary>
    public static string TerminalId(string pc, string pane) => $"{Prefix}{pc}:{pane}";

    /// <summary>Whether a terminal id is another computer's.</summary>
    public static bool Is(string? terminal) => terminal?.StartsWith(Prefix, StringComparison.Ordinal) == true;

    /// <summary>The computer and its terminal an id names; IOException when the computer isn't paired.</summary>
    private (RemotePc Pc, string Pane) Target(string terminal)
    {
        var rest = terminal[Prefix.Length..];
        var colon = rest.IndexOf(':');
        var pc = colon > 0 ? store.List().FirstOrDefault(p => p.Id == rest[..colon]) : null;
        return pc is null ? throw new IOException("That computer isn't paired any more.") : (pc, rest[(colon + 1)..]);
    }

    /// <summary>Asks the computer (<see cref="PcFiles"/>' JSON requests); its answer, or IOException with its reason.</summary>
    public async Task<JsonObject> AskAsync(string terminal, string path, JsonObject body)
    {
        var (pc, pane) = Target(terminal);
        body[PcFiles.Fields.Pane] = pane;
        using var client = PcConnection.ClientFor(pc, AskTimeout);
        try
        {
            using var response = await client.PostAsync(new Uri(path, UriKind.Relative), new StringContent(body.ToJsonString(), Encoding.UTF8, JsonType)).ConfigureAwait(false);
            return await AnswerOf(response, pc).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new IOException($"Couldn't reach {pc.Name}: {e.Message}", e);
        }
    }

    /// <summary>Sends a file or folder of this PC into a folder of the computer's terminal, under <paramref name="name"/>.</summary>
    public async Task PutAsync(string terminal, string local, string dir, string name)
    {
        var (pc, pane) = Target(terminal);
        var temp = Directory.CreateTempSubdirectory(TempPrefix).FullName;
        try
        {
            var zip = Path.Combine(temp, PcFiles.ItemZip);
            Pack(local, name, zip);
            using var client = PcConnection.ClientFor(pc, PutTimeout);
            await using var file = File.OpenRead(zip);
            using var content = new StreamContent(file);
            content.Headers.ContentLength = file.Length;
            content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
            using var request = new HttpRequestMessage(HttpMethod.Put, new Uri(PcFiles.Put, UriKind.Relative)) { Content = content };
            request.Headers.Add(PcFiles.Headers.Pane, pane);
            request.Headers.Add(PcFiles.Headers.Dir, PcFiles.Encode(dir));
            request.Headers.Add(PcFiles.Headers.Name, PcFiles.Encode(name));
            using var response = await client.SendAsync(request).ConfigureAwait(false);
            await AnswerOf(response, pc).ConfigureAwait(false);
        }
        catch (Exception e) when (e is HttpRequestException or TaskCanceledException)
        {
            throw new IOException($"Couldn't reach {pc.Name}: {e.Message}", e);
        }
        finally
        {
            Directory.Delete(temp, recursive: true);
        }
    }

    /// <summary>A zip holding the item under its new name: a file, or a folder and everything in it.</summary>
    private static void Pack(string local, string name, string zip)
    {
        using var archive = ZipFile.Open(zip, ZipArchiveMode.Create);
        if (File.Exists(local))
        {
            archive.CreateEntryFromFile(local, name, CompressionLevel.Fastest);
            return;
        }
        if (!Directory.Exists(local))
        {
            throw new IOException("It isn't there any more.");
        }
        archive.CreateEntry(name + "/");
        foreach (var entry in Directory.EnumerateFileSystemEntries(local, "*", SearchOption.AllDirectories))
        {
            var inside = name + "/" + Path.GetRelativePath(local, entry).Replace('\\', '/');
            if (Directory.Exists(entry))
            {
                archive.CreateEntry(inside + "/");
            }
            else
            {
                archive.CreateEntryFromFile(entry, inside, CompressionLevel.Fastest);
            }
        }
    }

    /// <summary>The computer's answer as JSON; IOException with its reason when it refused or failed.</summary>
    private static async Task<JsonObject> AnswerOf(HttpResponseMessage response, RemotePc pc)
    {
        var text = await response.Content.ReadAsStringAsync().ConfigureAwait(false);
        JsonObject? answer = null;
        try
        {
            answer = text.Length > 0 ? JsonNode.Parse(text) as JsonObject : null;
        }
        catch (JsonException)
        {
        }
        if (answer?[PcFiles.Fields.Error]?.GetValue<string>() is { } error)
        {
            throw new IOException(error);
        }
        if (response.StatusCode == System.Net.HttpStatusCode.Forbidden)
        {
            throw new IOException($"{pc.Name} doesn't know this computer any more: pair with it again.");
        }
        return response.IsSuccessStatusCode && answer is not null ? answer : throw new IOException($"{pc.Name} answered {(int)response.StatusCode}.");
    }
}
