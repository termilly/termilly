using System.Text.Json;
using System.Text.Json.Serialization;

namespace Termilly.Pty;

/// <summary>
/// What the window asks the background host (HostProtocol), as records: on the pipe, a JSON object with the kind
/// under "op" and then the fields.
/// </summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "op")]
[JsonDerivedType(typeof(Hello), "hello")]
[JsonDerivedType(typeof(Start), "start")]
[JsonDerivedType(typeof(Attach), "attach")]
[JsonDerivedType(typeof(Input), "input")]
[JsonDerivedType(typeof(Resize), "resize")]
[JsonDerivedType(typeof(Kill), "kill")]
[JsonDerivedType(typeof(Shutdown), "shutdown")]
public abstract record HostRequest
{
    /// <param name="V">The window's <see cref="HostProtocol.Version"/>.</param>
    public sealed record Hello(int V) : HostRequest;

    /// <summary>Starts a shell (replacing one with the same id).</summary>
    public sealed record Start(string Id, string Cmd, int Cols, int Rows, string? Cwd, IReadOnlyDictionary<string, string>? Env) : HostRequest;

    /// <summary>The window takes over a shell: the host sends its kept output again, then the live output.</summary>
    public sealed record Attach(string Id) : HostRequest;

    public sealed record Input(string Id, [property: JsonPropertyName("d")] string Data) : HostRequest;

    public sealed record Resize(string Id, int Cols, int Rows) : HostRequest;

    public sealed record Kill(string Id) : HostRequest;

    /// <summary>Ends every shell and the host itself (Settings › Stop background shells).</summary>
    public sealed record Shutdown : HostRequest;
}

/// <summary>What the background host tells the window, as records: on the pipe, the kind under "ev".</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "ev")]
[JsonDerivedType(typeof(Hello), "hello")]
[JsonDerivedType(typeof(Started), "started")]
[JsonDerivedType(typeof(Failed), "failed")]
[JsonDerivedType(typeof(Output), "out")]
[JsonDerivedType(typeof(Replay), "replay")]
[JsonDerivedType(typeof(Exited), "exit")]
public abstract record HostEvent
{
    /// <param name="V">The host's <see cref="HostProtocol.Version"/>.</param>
    /// <param name="Sessions">The shells it runs, from before this window too.</param>
    public sealed record Hello(int V, IReadOnlyList<Session> Sessions) : HostEvent;

    /// <param name="Exit">How it ended; null while it runs.</param>
    public sealed record Session(string Id, int Pid, bool Alive, int? Exit);

    public sealed record Started(string Id, int Pid) : HostEvent;

    public sealed record Failed(string Id, string Message) : HostEvent;

    public sealed record Output(string Id, [property: JsonPropertyName("d")] string Data) : HostEvent;

    /// <summary>The output the host kept for a shell, sent when a window attaches to it.</summary>
    public sealed record Replay(string Id, [property: JsonPropertyName("d")] string Data) : HostEvent;

    public sealed record Exited(string Id, int Code) : HostEvent;

    /// <summary>The exit code reported for a shell whose end the host couldn't learn.</summary>
    public const int UnknownExitCode = -1;
}

/// <summary>How the records are written on the pipe: camelCase names, as the JSON has always been.</summary>
internal static class HostJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web) { AllowOutOfOrderMetadataProperties = true };
}
