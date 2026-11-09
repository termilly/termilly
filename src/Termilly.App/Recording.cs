using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Security;
using Termilly.Pty;

namespace Termilly.Desktop;

/// <summary>A recording in the list: its file, size, and when it was last written (Unix milliseconds).</summary>
internal sealed record RecordingFile(string Path, string Name, long Size, long At);

/// <summary>
/// A terminal recorded as an asciicast v2 file (.cast), the format asciinema plays: a header line (size, time,
/// title), then one JSON array per event, [seconds, "o", output] for output, [seconds, "m", label] for a command
/// mark (from the shell's OSC 133 marks, sent by the page) and [seconds, "r", "COLSxROWS"] when the terminal
/// resizes. Input is never recorded (passwords). Secrets can be redacted as the output is written.
/// </summary>
internal sealed class Recording : IDisposable
{
    /// <summary>A recording stops by itself past this size.</summary>
    private const long DefaultMaxBytes = 100L << 20;
    /// <summary>The asciicast format's version, and the terminal type its players emulate.</summary>
    private const int CastVersion = 2;
    /// <summary>Event times are kept to the microsecond.</summary>
    private const int TimeDigits = 6;
    /// <summary>How many recordings the list shows.</summary>
    private const int DefaultListCount = 30;

    /// <summary>Where recordings go unless Settings say otherwise: Documents\Termilly\recordings.</summary>
    public static string DefaultFolder => AppPaths.RecordingsFolder;

    private readonly object _gate = new();
    private readonly StreamWriter _writer;
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly bool _redact;
    private readonly long _maxBytes;
    private bool _stopped;

    public Recording(string path, int cols, int rows, string title, bool redact, long maxBytes = DefaultMaxBytes)
    {
        Path = path;
        _redact = redact;
        _maxBytes = maxBytes;
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        _writer = new StreamWriter(new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)) { AutoFlush = true };
        var header = new JsonObject
        {
            ["version"] = CastVersion,
            ["width"] = cols,
            ["height"] = rows,
            ["timestamp"] = DateTimeOffset.Now.ToUnixTimeSeconds(),
            ["title"] = title,
            ["env"] = new JsonObject { [TerminalVariables.Term] = TerminalVariables.Xterm256Color },
        };
        _writer.Write(header.ToJsonString() + "\n");
    }

    public string Path { get; }

    /// <summary>Whether it stopped by itself (the size cap).</summary>
    public bool Full { get; private set; }

    /// <summary>
    /// A recording's file name: {folder}/{terminal}_{date}_{time}.cast, characters files can't have taken out.
    /// </summary>
    public static string PathFor(string folder, string terminal, DateTime when)
    {
        var name = string.Concat((terminal ?? "").Split(System.IO.Path.GetInvalidFileNameChars())).Trim();
        name = name.Length == 0 ? SessionLog.UnnamedTerminal : name.Length > SessionLog.MaxNamePart ? name[..SessionLog.MaxNamePart] : name;
        return System.IO.Path.Combine(folder, $"{name}_{when:yyyy-MM-dd_HH-mm-ss}.cast");
    }

    public void Output(string data) => Event("o", _redact ? SecretRedactor.Redact(data) : data);

    public void Mark(string label) => Event("m", label);

    public void Resize(int cols, int rows) => Event("r", $"{cols}x{rows}");

    private void Event(string kind, string data)
    {
        lock (_gate)
        {
            if (_stopped)
            {
                return;
            }
            var seconds = Math.Round(_clock.Elapsed.TotalSeconds, TimeDigits);
            _writer.Write($"[{seconds.ToString(System.Globalization.CultureInfo.InvariantCulture)}, {JsonSerializer.Serialize(kind)}, {JsonSerializer.Serialize(data)}]\n");
            if (_writer.BaseStream.Length > _maxBytes)
            {
                Full = true;
                _stopped = true;
                _writer.Dispose();
            }
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_stopped)
            {
                return;
            }
            _stopped = true;
            _writer.Dispose();
        }
    }

    /// <summary>The recordings in a folder, newest first.</summary>
    public static IReadOnlyList<RecordingFile> List(string folder, int max = DefaultListCount)
    {
        if (!Directory.Exists(folder))
        {
            return [];
        }
        return new DirectoryInfo(folder).EnumerateFiles("*.cast").OrderByDescending(f => f.LastWriteTimeUtc).Take(max)
            .Select(f => new RecordingFile(f.FullName, f.Name, f.Length, new DateTimeOffset(f.LastWriteTimeUtc).ToUnixTimeMilliseconds()))
            .ToList();
    }
}
