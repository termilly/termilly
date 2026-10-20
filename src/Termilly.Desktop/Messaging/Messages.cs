using System.Text.Json;

namespace Termilly.Desktop.Messaging;

/// <summary>
/// A message the page sends the host (js/host.js send), as a record of what it carries. <see cref="Type"/> is the
/// message's name on the wire, written once here; js/protocol.js has the same names (ProtocolTests keeps them equal).
/// </summary>
internal interface IPageMessage
{
    static abstract string Type { get; }
}

/// <summary>A message the host sends the page (js/host.js onHost). Several records may share a type: its variants.</summary>
internal interface IHostMessage
{
    static abstract string Type { get; }
}

/// <summary>
/// The page's messages, by type: each one is read into its record (<see cref="FromPage"/>) and handed to the code
/// registered for it. A message nobody registered, or one that doesn't read as its record, is reported and dropped.
/// </summary>
internal sealed class MessageRouter(JsonSerializerOptions options)
{
    private readonly Dictionary<string, Action<JsonElement, IReadOnlyList<string>?>> _handlers = new(StringComparer.Ordinal);

    /// <summary>The types something is registered for.</summary>
    public IEnumerable<string> Types => _handlers.Keys;

    public void On<T>(Action<T> handle)
        where T : IPageMessage => On<T>((message, _) => handle(message));

    /// <summary>A handler that works in the background (a dialog, a network call): it runs on, unawaited, as the page doesn't wait for it.</summary>
    public void On<T>(Func<T, Task> handle)
        where T : IPageMessage => On<T>((message, files) => _ = handle(message));

    /// <param name="handle">Takes the message and the files the browser handed over with it (dropped or picked), if any.</param>
    public void On<T>(Action<T, IReadOnlyList<string>?> handle)
        where T : IPageMessage =>
        _handlers.Add(T.Type, (json, files) =>
            handle(json.Deserialize<T>(options) ?? throw new JsonException($"An empty {T.Type} message."), files));

    /// <summary>Hands the message to what's registered for its type; false when nothing is.</summary>
    public bool Dispatch(JsonElement message, IReadOnlyList<string>? files)
    {
        var type = message.TryGetProperty(HostMessage.TypeProperty, out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()! : "";
        if (!_handlers.TryGetValue(type, out var handle))
        {
            return false;
        }
        try
        {
            handle(message, files);
        }
        catch (JsonException e)
        {
            Console.Error.WriteLine($"termilly: the page's {type} message doesn't read: {e.Message}");
        }
        return true;
    }
}

/// <summary>Writes the host's messages: the record's own fields, with its type first.</summary>
internal static class HostMessage
{
    /// <summary>The property that names a message's type, both ways.</summary>
    public const string TypeProperty = "type";

    public static string Json<T>(T message, JsonSerializerOptions options)
        where T : IHostMessage
    {
        var body = JsonSerializer.Serialize(message, options);
        var type = JsonSerializer.Serialize(T.Type, options);
        return body.Length > EmptyObject.Length ? $"{{\"{TypeProperty}\":{type},{body[1..]}" : $"{{\"{TypeProperty}\":{type}}}";
    }

    private const string EmptyObject = "{}";
}
