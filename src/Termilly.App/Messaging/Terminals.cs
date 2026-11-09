using System.Text.Json;

namespace Termilly.Desktop.Messaging;

// Terminals: starting, typing, resizing and closing them, what they print, and tmux in control mode.

internal static partial class FromPage
{
    /// <param name="Cwd">The folder it was last in, or the workspace's.</param>
    /// <param name="FallbackCwd">Where to start when <paramref name="Cwd"/> is gone.</param>
    /// <param name="Env">A layout's own variables for this terminal.</param>
    internal sealed record Start(string Id = "", string? Profile = null, string? Cwd = null, int Cols = 0, int Rows = 0,
        JsonElement? Env = null, string? FallbackCwd = null) : IPageMessage
    {
        public static string Type => "start";
    }

    internal sealed record Input(string Id = "", string? Data = null) : IPageMessage
    {
        public static string Type => "input";
    }

    internal sealed record Resize(string Id = "", int Cols = 0, int Rows = 0) : IPageMessage
    {
        public static string Type => "resize";
    }

    internal sealed record Kill(string Id = "") : IPageMessage
    {
        public static string Type => "kill";
    }

    /// <summary>Files dropped on a terminal; <see cref="Paths"/> when the page read them itself (file:// URLs).</summary>
    internal sealed record FilesDrop(string Id = "", IReadOnlyList<string>? Paths = null) : IPageMessage
    {
        public static string Type => "files:drop";
    }

    internal sealed record SerialBreak(string Id = "") : IPageMessage
    {
        public static string Type => "serial:break";
    }

    internal sealed record SerialHex(string Id = "", bool On = false) : IPageMessage
    {
        public static string Type => "serial:hex";
    }

    internal sealed record SerialEol(string Id = "", string? Eol = null) : IPageMessage
    {
        public static string Type => "serial:eol";
    }

    /// <summary>"Stop background shells": the background host ends, and with it the shells it kept.</summary>
    internal sealed record HostShutdown : IPageMessage
    {
        public static string Type => "host:shutdown";
    }

    /// <summary>The ports each terminal's processes listen on.</summary>
    internal sealed record PortsTerminals : IPageMessage
    {
        public static string Type => "ports:terminals";
    }

    internal sealed record TmuxStart(string Id = "", string? Command = null) : IPageMessage
    {
        public static string Type => "tmux:start";
    }

    internal sealed record TmuxWrite(string Id = "", string? Text = null) : IPageMessage
    {
        public static string Type => "tmux:write";
    }

    internal sealed record TmuxStop(string Id = "") : IPageMessage
    {
        public static string Type => "tmux:stop";
    }
}

internal static partial class ToPage
{
    internal sealed record Output(string Id, string Data) : IHostMessage
    {
        public static string Type => "output";
    }

    internal sealed record Exit(string Id, int Code) : IHostMessage
    {
        public static string Type => "exit";
    }

    internal sealed record Error(string Id, string Message) : IHostMessage
    {
        public static string Type => "error";
    }

    /// <summary>The folder a terminal was to start in is gone; it started in <see cref="Folder"/> instead.</summary>
    internal sealed record StartFolder(string Id, string? Missing, string Folder) : IHostMessage
    {
        public static string Type => "start:folder";
    }

    /// <summary>The background host kept this terminal's shell while no window was open, and it's taken back.</summary>
    internal sealed record Attached(string Id) : IHostMessage
    {
        public static string Type => "attached";
    }

    /// <summary>Whether a terminal runs a command (<see cref="Busy"/>) or waits on the user in a program (<see cref="Interactive"/>).</summary>
    internal sealed record Busy(string Id, [property: System.Text.Json.Serialization.JsonPropertyName("busy")] bool IsBusy, string? Name, bool Interactive) : IHostMessage
    {
        public static string Type => "busy";
    }

    internal sealed record FilesDropped(string Id, IReadOnlyList<string> Paths) : IHostMessage
    {
        public static string Type => "files:dropped";
    }

    internal sealed record TerminalPorts(IReadOnlyDictionary<string, int[]> Ports) : IHostMessage
    {
        public static string Type => "ports:terminals";
    }

    internal sealed record TmuxData(string Id, string Data) : IHostMessage
    {
        public static string Type => "tmux:data";
    }

    internal sealed record TmuxExit(string Id, int Code) : IHostMessage
    {
        public static string Type => "tmux:exit";
    }

    internal sealed record TmuxFailed(string Id, int Code, string Error) : IHostMessage
    {
        public static string Type => "tmux:exit";
    }
}
