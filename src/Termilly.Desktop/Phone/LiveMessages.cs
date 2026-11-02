using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Phone;

/// <summary>Reading what a phone sends over its WebSocket (Phone/PhoneLive.cs): whole text messages, as JSON.</summary>
internal static class LiveMessages
{
    private const int ReceiveChunk = 4096;

    /// <summary>One whole text message, or null when the phone went away or sent too much.</summary>
    public static async Task<string?> ReceiveAsync(WebSocket socket, int maxMessage, CancellationToken stop)
    {
        var buffer = new byte[ReceiveChunk];
        using var message = new MemoryStream();
        while (true)
        {
            var result = await socket.ReceiveAsync(buffer, stop).ConfigureAwait(false);
            if (result.MessageType == WebSocketMessageType.Close || message.Length + result.Count > maxMessage)
            {
                return null;
            }
            message.Write(buffer, 0, result.Count);
            if (result.EndOfMessage)
            {
                return result.MessageType == WebSocketMessageType.Text ? Encoding.UTF8.GetString(message.ToArray()) : "";
            }
        }
    }

    public static JsonObject? Parse(string text)
    {
        try
        {
            return JsonNode.Parse(text) as JsonObject;
        }
        catch (JsonException)
        {
            return null;
        }
    }
}
