using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace Termilly.Desktop.Services;

/// <summary>A program to run to its end, and how.</summary>
/// <param name="Arguments">Each argument as it is (quoted for the system as needed).</param>
internal sealed record ProcessRequest(string File, IReadOnlyList<string> Arguments)
{
    /// <summary>Instead of <see cref="Arguments"/>: a whole command line, for arguments that are one already (an SSH profile's).</summary>
    public string? CommandLine { get; init; }

    public string? WorkingDirectory { get; init; }

    /// <summary>Variables set for it, on top of this process's own.</summary>
    public IReadOnlyDictionary<string, string>? Environment { get; init; }

    /// <summary>How long it may take before it's ended (with what it started).</summary>
    public TimeSpan Timeout { get; init; } = ProcessRunner.DefaultTimeout;

    /// <summary>Output past this many bytes isn't read: the result says <see cref="ProcessResult.Truncated"/>.</summary>
    public long MaxOutputBytes { get; init; } = ProcessRunner.DefaultMaxOutput;

    /// <summary>Written to the program's input; without <see cref="DoneWhen"/> the input is closed after it.</summary>
    public string? Input { get; init; }

    /// <summary>
    /// For a program that answers and then waits for more (a JSON-RPC server): once the output so far says this, the
    /// program is ended and what it wrote is the result (exit code 0). Its input stays open till then.
    /// </summary>
    public Func<byte[], bool>? DoneWhen { get; init; }
}

/// <summary>How a program ended: its exit code, what it wrote, and what it wrote to stderr.</summary>
internal sealed record ProcessResult(int ExitCode, byte[] Output, string Error, bool Truncated)
{
    public bool Succeeded => ExitCode == 0;

    /// <summary>The output as UTF-8 text.</summary>
    public string Text => Encoding.UTF8.GetString(Output);

    /// <summary>stderr's first line that says something, or null.</summary>
    public string? FirstErrorLine => ErrorLines.FirstOrDefault();

    /// <summary>stderr's lines that say something, trimmed.</summary>
    public IEnumerable<string> ErrorLines => Error.Split('\n').Select(l => l.Trim()).Where(l => l.Length > 0);
}

/// <summary>A program that isn't installed or isn't on PATH.</summary>
internal sealed class ProgramMissingException(string program, Exception inner) : IOException($"{program} isn't installed, or isn't on PATH.", inner)
{
    public string Program { get; } = program;
}

/// <summary>A program that ran past its time and was ended.</summary>
internal sealed class ProcessTimeoutException(string program) : IOException($"{program} took too long.");

/// <summary>Runs programs to their end: git, ssh, sftp, claude, docker, kubectl, fc-list.</summary>
internal interface IProcessRunner
{
    /// <summary>
    /// Runs <paramref name="request"/> with nothing to type into (a question ends it rather than hanging); throws
    /// <see cref="ProgramMissingException"/> or <see cref="ProcessTimeoutException"/>. A non-zero exit is a result,
    /// not an exception.
    /// </summary>
    ProcessResult Run(ProcessRequest request);

    Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancel = default);
}

internal sealed class ProcessRunner : IProcessRunner
{
    public static readonly TimeSpan DefaultTimeout = TimeSpan.FromSeconds(20);
    public const long DefaultMaxOutput = 64L << 20;
    private const int ReadBuffer = 64 * 1024;
    /// <summary>The most of a program's error output kept, in characters (what's shown of it is its first lines).</summary>
    internal const int MaxErrorChars = 1 << 20;

    public ProcessResult Run(ProcessRequest request) => RunAsync(request).GetAwaiter().GetResult();

    public async Task<ProcessResult> RunAsync(ProcessRequest request, CancellationToken cancel = default)
    {
        using var process = Start(request);
        if (request.Input is { } input)
        {
            await process.StandardInput.WriteAsync(input).ConfigureAwait(false);
            await process.StandardInput.FlushAsync(cancel).ConfigureAwait(false);
        }
        if (request.DoneWhen is null)
        {
            process.StandardInput.Close();
        }
        var error = ReadErrorAsync(process.StandardError, MaxErrorChars);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(request.Timeout);
        try
        {
            var (output, truncated, done) = await ReadOutputAsync(process.StandardOutput.BaseStream, request.MaxOutputBytes, request.DoneWhen, timeout.Token).ConfigureAwait(false);
            if (truncated || done)
            {
                Kill(process);
            }
            if (done)
            {
                return new ProcessResult(0, output, "", Truncated: false);
            }
            await process.WaitForExitAsync(timeout.Token).ConfigureAwait(false);
            return new ProcessResult(process.ExitCode, output, await error.ConfigureAwait(false), truncated);
        }
        catch (OperationCanceledException)
        {
            // Timed out, or the caller gave up (a newer search): either way the program stops too.
            Kill(process);
            if (cancel.IsCancellationRequested)
            {
                throw;
            }
            throw new ProcessTimeoutException(Path.GetFileNameWithoutExtension(request.File));
        }
    }

    private static Process Start(ProcessRequest request)
    {
        var start = new ProcessStartInfo(request.File)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardErrorEncoding = Encoding.UTF8,
            WorkingDirectory = request.WorkingDirectory ?? "",
        };
        if (request.CommandLine is { } commandLine)
        {
            start.Arguments = commandLine;
        }
        else
        {
            foreach (var argument in request.Arguments)
            {
                start.ArgumentList.Add(argument);
            }
        }
        foreach (var (name, value) in request.Environment ?? new Dictionary<string, string>())
        {
            start.Environment[name] = value;
        }
        try
        {
            return Process.Start(start) ?? throw new IOException($"{request.File} couldn't start.");
        }
        catch (Win32Exception e)
        {
            throw new ProgramMissingException(Path.GetFileNameWithoutExtension(request.File), e);
        }
    }

    /// <summary>
    /// Everything the program writes, up to the limit; past it, what was read and that there was more. With
    /// <paramref name="doneWhen"/>, it stops as soon as the output says so.
    /// </summary>
    private static async Task<(byte[] Output, bool Truncated, bool Done)> ReadOutputAsync(Stream stdout, long maxBytes, Func<byte[], bool>? doneWhen, CancellationToken cancel)
    {
        using var output = new MemoryStream();
        var buffer = new byte[ReadBuffer];
        int read;
        while ((read = await stdout.ReadAsync(buffer, cancel).ConfigureAwait(false)) > 0)
        {
            if (output.Length + read > maxBytes)
            {
                return (output.ToArray(), true, false);
            }
            output.Write(buffer, 0, read);
            if (doneWhen?.Invoke(output.ToArray()) == true)
            {
                return (output.ToArray(), false, true);
            }
        }
        return (output.ToArray(), false, false);
    }

    /// <summary>
    /// A program's error output, its first <paramref name="maxChars"/> characters: the rest is read and dropped, so a
    /// program writing errors without end neither fills memory nor stops on a full pipe.
    /// </summary>
    internal static async Task<string> ReadErrorAsync(TextReader stderr, int maxChars)
    {
        var kept = new StringBuilder();
        var buffer = new char[ReadBuffer];
        int read;
        while ((read = await stderr.ReadAsync(buffer, CancellationToken.None).ConfigureAwait(false)) > 0)
        {
            var room = maxChars - kept.Length;
            if (room > 0)
            {
                kept.Append(buffer, 0, Math.Min(room, read));
            }
        }
        return kept.ToString();
    }

    private static void Kill(Process process)
    {
        try
        {
            process.Kill(entireProcessTree: true);
        }
        catch (Exception e) when (e is InvalidOperationException or Win32Exception)
        {
            // Already gone.
        }
    }
}
