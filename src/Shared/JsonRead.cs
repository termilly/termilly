using System.Text.Json.Nodes;

namespace Termilly.Shared;

/// <summary>
/// Reading a typed value from JSON that came from elsewhere (a phone, another computer, a hook, a file): a field
/// that's missing or of another type is null, where JsonNode.GetValue throws. Whoever reads it decides what null means
/// (a bad request, an ignored message, a default), so valid JSON with a wrong type can't fault a request or a reader.
/// </summary>
internal static class JsonRead
{
    /// <summary>The node's text, or null when it isn't a JSON string.</summary>
    public static string? AsText(this JsonNode? node) => node is JsonValue v && v.TryGetValue<string>(out var text) ? text : null;

    /// <summary>The node's true or false, or null when it isn't a JSON boolean.</summary>
    public static bool? AsBool(this JsonNode? node) => node is JsonValue v && v.TryGetValue<bool>(out var flag) ? flag : null;

    /// <summary>The node's whole number, or null when it isn't one that fits a long.</summary>
    public static long? AsLong(this JsonNode? node) => node is not JsonValue v ? null
        : v.TryGetValue<long>(out var whole) ? whole
        : v.TryGetValue<int>(out var small) ? small
        : null;

    /// <summary>The node's whole number, or null when it isn't one that fits an int.</summary>
    public static int? AsInt(this JsonNode? node) => node.AsLong() is { } whole && whole is >= int.MinValue and <= int.MaxValue ? (int)whole : null;
}
