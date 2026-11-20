using System.Runtime.InteropServices;
using System.Text;

namespace Termilly.Agent;

/// <summary>
/// Standard output and error that keep every character. .NET writes them in the console's code page on Windows (936,
/// 775, 437), which has no room for most of the world's letters: a folder named "Тест" came out as "????". To a pipe or
/// a file (Claude Code, Git Bash, a script) it's UTF-8; to a Windows console, the console's own wide-character call.
/// </summary>
internal static class Utf8Output
{
    /// <summary>UTF-8 without a byte order mark, which a reader would take for text.</summary>
    public static readonly UTF8Encoding Encoding = new(encoderShouldEmitUTF8Identifier: false);

    private const int StdOutputHandle = -11;
    private const int StdErrorHandle = -12;

    public static TextWriter Out() => Writer(Console.IsOutputRedirected, Console.OpenStandardOutput, StdOutputHandle);

    public static TextWriter Error() => Writer(Console.IsErrorRedirected, Console.OpenStandardError, StdErrorHandle);

    /// <summary>A writer for one stream: UTF-8 to <paramref name="open"/>'s stream unless it's a Windows console.</summary>
    internal static TextWriter Writer(bool redirected, Func<Stream> open, int handle) =>
        !redirected && OperatingSystem.IsWindows() && GetStdHandle(handle) is var console && GetConsoleMode(console, out _)
            ? new ConsoleWriter(console)
            : new StreamWriter(open(), Encoding) { AutoFlush = true };

    /// <summary>Text straight to a Windows console as UTF-16, whatever its code page.</summary>
    private sealed class ConsoleWriter(nint console) : TextWriter
    {
        /// <summary>The most characters sent at once: the console refuses very long writes.</summary>
        private const int Chunk = 8192;
        /// <summary>The first half of a character written one half at a time (an emoji), held until its second half.</summary>
        private char? _high;

        public override Encoding Encoding => System.Text.Encoding.Unicode;

        public override void Write(char value)
        {
            if (char.IsHighSurrogate(value))
            {
                _high = value;
                return;
            }
            Write(_high is { } high ? $"{high}{value}" : value.ToString());
        }

        public override void Write(char[] buffer, int index, int count) => Write(new string(buffer, index, count));

        public override void Write(string? value)
        {
            var text = _high is { } high ? high + (value ?? "") : value ?? "";
            _high = null;
            while (text.Length > 0)
            {
                // Never cut a character in two at the end of a chunk.
                var take = Math.Min(text.Length, Chunk);
                if (take < text.Length && char.IsHighSurrogate(text[take - 1]))
                {
                    take--;
                }
                if (!WriteConsoleW(console, text, take, out var written, 0) || written <= 0)
                {
                    throw new IOException($"The console refused the text (error {Marshal.GetLastPInvokeError()}).");
                }
                text = text[written..];
            }
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern nint GetStdHandle(int handle);

    /// <summary>Whether a handle is a console (it has a mode); a file or pipe handle doesn't.</summary>
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetConsoleMode(nint handle, out int mode);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool WriteConsoleW(nint console, string text, int length, out int written, nint reserved);
}
