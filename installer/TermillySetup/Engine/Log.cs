using System;
using System.IO;
using System.Text;

namespace Termilly.Setup.Engine;

/// <summary>Setup's log, in %TEMP%\TermillySetup-*\setup.log; the Details panel and the error page show it.</summary>
internal static class Log
{
    private static readonly object Gate = new();
    private static readonly StringBuilder Text = new();

    public static string Folder { get; } = Path.Combine(Path.GetTempPath(), $"TermillySetup-{Guid.NewGuid().ToString("N").Substring(0, 6)}");

    public static string FilePath => Path.Combine(Folder, "setup.log");

    /// <summary>Raised (on any thread) with each new line.</summary>
    public static event Action<string>? Added;

    public static void Write(string message)
    {
        var line = $"[{DateTime.Now:HH:mm:ss}] {message}";
        lock (Gate)
        {
            Text.AppendLine(line);
            try
            {
                Directory.CreateDirectory(Folder);
                File.AppendAllText(FilePath, line + Environment.NewLine, Encoding.UTF8); // with a BOM, so every editor shows its "…" right
            }
            catch (IOException)
            {
                // The log is a help, never a reason to fail.
            }
            catch (UnauthorizedAccessException)
            {
            }
        }
        Added?.Invoke(line);
    }

    public static string All
    {
        get
        {
            lock (Gate)
            {
                return Text.ToString();
            }
        }
    }
}
