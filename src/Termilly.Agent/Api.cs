using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Agent;

/// <summary>
/// Termilly's API over its named pipe: one JSON request line { v, api, ...arguments }, one JSON reply line
/// { ok, result } or { ok: false, error }. The CLI (Cli.cs) and the MCP server (Mcp.cs) are both clients.
/// </summary>
internal static class Api
{
    /// <summary>
    /// The pipe to talk to: the Termilly window that owns this terminal, else the first one running (for scripts
    /// and agents started outside Termilly). Null when no Termilly is running.
    /// </summary>
    public static string? FindPipe()
    {
        if (Environment.GetEnvironmentVariable(Protocol.PipeVariable) is { Length: > 0 } own)
        {
            return own;
        }
        try
        {
            if (!OperatingSystem.IsWindows())
            {
                // .NET's named pipes are Unix sockets in the temp folder here; a window's is named after its process,
                // so one left behind by a Termilly that crashed is skipped.
                const string prefix = "CoreFxPipe_";
                return Directory.GetFiles(Path.GetTempPath(), prefix + PipeNames.Prefix + "*")
                    .Select(file => Path.GetFileName(file)[prefix.Length..])
                    .FirstOrDefault(name => name == PipeNames.Main ||
                                            int.TryParse(name[PipeNames.Prefix.Length..], out var pid) && Directory.Exists($"/proc/{pid}"));
            }
            return Directory.GetFiles(@"\\.\pipe\")
                .Select(Path.GetFileName)
                .FirstOrDefault(name => name is not null && (name == PipeNames.Main || name.StartsWith(PipeNames.Prefix) && int.TryParse(name[PipeNames.Prefix.Length..], out _)));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>Calls one method; throws <see cref="ApiException"/> with Termilly's message when it says no.</summary>
    public static JsonNode? Call(string method, JsonObject? arguments = null, string? pipe = null)
    {
        pipe ??= FindPipe() ?? throw new ApiException("Termilly isn't running.");
        var request = arguments?.DeepClone().AsObject() ?? [];
        request[ApiFields.Version] = Protocol.Version;
        request[ApiFields.Method] = method;
        // Which terminal asks (its own), so Termilly can show who read or typed into another one.
        if (request[ApiFields.From] is null && Environment.GetEnvironmentVariable(Protocol.PaneVariable) is { Length: > 0 } from)
        {
            request[ApiFields.From] = from;
        }
        // Typing may wait for the user to say yes (a terminal on production), so it gets longer.
        var line = Protocol.Send(pipe, request.ToJsonString(), PipeTimeouts.ForApi(method))
            ?? throw new ApiException("Termilly didn't answer.");
        var reply = JsonNode.Parse(line) as JsonObject ?? throw new ApiException("Termilly's answer wasn't readable.");
        if (reply[ApiFields.Ok]?.GetValue<bool>() != true)
        {
            throw new ApiException(reply[ApiFields.Error]?.ToString() ?? "Termilly refused.");
        }
        return reply[ApiFields.Result];
    }

    /// <summary>JSON's nothing, as a reply without a result prints.</summary>
    private const string JsonNull = "null";

    public static string Pretty(JsonNode? node) => node?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? JsonNull;
}

internal sealed class ApiException(string message) : Exception(message);
