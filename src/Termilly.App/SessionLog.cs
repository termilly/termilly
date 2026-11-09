using System.IO;
using System.Text;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// A terminal's output written to a log file ("Log to file" in the terminal menu, or always for some tags and
/// profiles), as SecureCRT and PuTTY do: for audits, change records and support tickets. Unlike the history it
/// isn't encrypted.
/// <list type="bullet">
/// <item><b>Plain</b> logs get the lines as the terminal shows them, from the page (js/logging.js): escape codes
/// gone, progress bars and redrawn prompts as they ended up, wrapped lines joined, each command marked
/// (<c>$ git push</c> … <c>[exit 0, 2.1 s]</c>). Secrets are redacted here, as in the history.</item>
/// <item><b>Raw</b> logs keep the output stream as it came, so <c>cat</c> replays it.</item>
/// </list>
/// </summary>
internal sealed class SessionLog : IDisposable
{
    /// <summary>The longest workspace or terminal name a log or recording's file name keeps.</summary>
    public const int MaxNamePart = 60;
    /// <summary>A terminal without a usable name, in a file name.</summary>
    public const string UnnamedTerminal = "terminal";
    private const string UnnamedWorkspace = "workspace";
    /// <summary>A log is continued in a new part past this size.</summary>
    private const long DefaultMaxBytes = 20 * 1024 * 1024;

    /// <summary>Where logs go unless Settings say otherwise: Documents\Termilly\logs.</summary>
    public static string DefaultFolder => AppPaths.LogsFolder;

    private readonly object _gate = new();
    private readonly bool _timestamps;
    private readonly bool _redact;
    private readonly long _maxBytes;
    private readonly string _basePath;
    private StreamWriter _writer;
    private int _part = 1;
    private bool _disposed;

    public SessionLog(string path, bool raw, bool timestamps, bool redact, long maxBytes = DefaultMaxBytes)
    {
        Raw = raw;
        _timestamps = timestamps;
        _redact = redact;
        _maxBytes = maxBytes;
        _basePath = path;
        Directory.CreateDirectory(System.IO.Path.GetDirectoryName(path)!);
        _writer = Open(path);
        Path = path;
        if (!raw)
        {
            Write($"# Termilly session log, started {DateTime.Now:yyyy-MM-dd HH:mm:ss}{(redact ? "; secrets redacted" : "")}");
        }
    }

    /// <summary>The file being written now (a new part after rotation).</summary>
    public string Path { get; private set; }

    public bool Raw { get; }

    /// <summary>
    /// A log file's path: <c>{folder}/{workspace}/{terminal}_{date}_{time}.log</c>, with characters files can't have
    /// taken out of the names.
    /// </summary>
    public static string PathFor(string folder, string workspace, string terminal, DateTime when, bool raw) =>
        System.IO.Path.Combine(folder, Clean(workspace, UnnamedWorkspace), $"{Clean(terminal, UnnamedTerminal)}_{when:yyyy-MM-dd_HH-mm-ss}{(raw ? ".raw" : "")}.log");

    private static string Clean(string name, string fallback)
    {
        var clean = string.Concat((name ?? "").Split(System.IO.Path.GetInvalidFileNameChars())).Trim().TrimEnd('.');
        return clean.Length == 0 ? fallback : clean.Length > MaxNamePart ? clean[..MaxNamePart] : clean;
    }

    /// <summary>Deletes logs older than <paramref name="days"/> under <paramref name="folder"/> (0 keeps them all).</summary>
    public static void DeleteOld(string folder, int days)
    {
        if (days <= 0 || !Directory.Exists(folder))
        {
            return;
        }
        var cutoff = DateTime.Now.AddDays(-days);
        foreach (var file in Directory.EnumerateFiles(folder, "*.log", SearchOption.AllDirectories))
        {
            try
            {
                if (File.GetLastWriteTime(file) < cutoff)
                {
                    File.Delete(file);
                }
            }
            catch (Exception e) when (Storage.IsFileError(e))
            {
                // In use or not ours to delete: left for next time.
            }
        }
    }

    /// <summary>Output from the terminal as it arrives; only raw logs keep it.</summary>
    public void Output(string data)
    {
        if (!Raw)
        {
            return;
        }
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _writer.Write(data);
            Rotate();
        }
    }

    /// <summary>Finished lines as the terminal shows them, and command marks (plain logs).</summary>
    public void Lines(IEnumerable<string> lines)
    {
        if (Raw)
        {
            return;
        }
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            foreach (var line in lines)
            {
                Write(line);
            }
            Rotate();
        }
    }

    private void Write(string text)
    {
        if (_redact)
        {
            text = SecretRedactor.Redact(text);
        }
        text = text.Replace("\r", "").Replace("\n", " ").TrimEnd();
        _writer.Write(_timestamps ? $"[{DateTime.Now:HH:mm:ss}] {text}\n" : $"{text}\n");
    }

    /// <summary>A new part once the file is past the size cap: name_2.log, name_3.log…</summary>
    private void Rotate()
    {
        if (_writer.BaseStream.Length < _maxBytes)
        {
            return;
        }
        _writer.Dispose();
        _part++;
        Path = System.IO.Path.Combine(System.IO.Path.GetDirectoryName(_basePath)!,
            $"{System.IO.Path.GetFileNameWithoutExtension(_basePath)}_{_part}{System.IO.Path.GetExtension(_basePath)}");
        _writer = Open(Path);
    }

    private static StreamWriter Open(string path) =>
        new(new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.Read), new UTF8Encoding(false)) { AutoFlush = true };

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            if (!Raw)
            {
                Write($"# ended {DateTime.Now:yyyy-MM-dd HH:mm:ss}");
            }
            _writer.Dispose();
        }
    }
}
