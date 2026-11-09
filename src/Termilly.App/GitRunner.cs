using System.Collections.Concurrent;
using System.IO;
using System.Text;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Where the Git window's git runs (GitView): on this PC, or on the server an SSH terminal is connected to, through
/// ssh with that terminal's host, user, keys and jump hosts. Both check what the page sends the same way: a root must
/// be a repository's own root, and paths must stay inside it.
/// </summary>
internal abstract class GitRunner(IProcessRunner runner)
{
    /// <summary>What every call runs with: no optional locks, paths as they are, no colour or signatures.</summary>
    protected static readonly string[] Options = ["--no-optional-locks", "-c", "core.quotepath=off", "-c", "color.ui=false", "-c", "log.showSignature=false"];

    /// <summary>
    /// What git runs with, here and on servers: messages in English (GitView reads some), no pager, no prompts
    /// (nothing could answer them), no optional locks.
    /// </summary>
    protected static readonly IReadOnlyDictionary<string, string> Environment = new Dictionary<string, string>
    {
        ["LC_ALL"] = "C", ["GIT_PAGER"] = "cat", ["GIT_TERMINAL_PROMPT"] = "0", ["GIT_OPTIONAL_LOCKS"] = "0",
    };

    /// <summary>The most of git's error kept for the page, in characters.</summary>
    private const int MaxDetail = 4000;

    /// <summary>Path parts that would leave the repository, or name nothing.</summary>
    private static readonly string[] OutsideParts = ["..", ".", ""];

    /// <summary>git's output for <paramref name="args"/> in <paramref name="root"/>; IOException with git's message when it fails.</summary>
    public abstract byte[] Run(string root, IReadOnlyList<string> args);

    /// <summary>
    /// A file in the working tree, at most <paramref name="maxBytes"/>; missing when it isn't there. With
    /// <paramref name="keepBytes"/>, its bytes are kept even when it's binary (<see cref="Blob.Raw"/>).
    /// </summary>
    public abstract Blob ReadFile(string root, string path, long maxBytes, bool keepBytes = false);

    /// <summary>Adds a line at the end of a file in the working tree (made if missing), on a line of its own.</summary>
    public abstract void AppendLine(string root, string path, string line);

    /// <summary>The repository root a folder is in, or null.</summary>
    public abstract string? RootOf(string? folder);

    /// <summary>A root the page sent back: it must be a repository's own root folder.</summary>
    public abstract string CheckRoot(string? root);

    /// <summary>A path inside the repository, as git writes it (forward slashes, relative to the root).</summary>
    public virtual string CheckPath(string root, string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path.Contains('\0') || path.Contains('\n') || Path.IsPathRooted(path) || path.StartsWith('-') || path.Contains(':'))
        {
            throw new ArgumentException("That path isn't in the repository.");
        }
        var git = path.Replace('\\', '/');
        if (git.StartsWith('/') || git.Split('/').Any(OutsideParts.Contains))
        {
            throw new ArgumentException("That path isn't in the repository.");
        }
        return git;
    }

    /// <summary>Runs git (or ssh) to its end: its output, or <see cref="GitFailedException"/> with all it wrote to stderr.</summary>
    protected byte[] Collect(ProcessRequest request, string what)
    {
        var result = runner.Run(request);
        if (result.Succeeded)
        {
            return result.Output;
        }
        var detail = result.Error.Replace("\r\n", "\n").Trim();
        throw new GitFailedException(result.ExitCode, result.FirstErrorLine ?? $"{what} failed ({result.ExitCode}).",
            detail.Length > 0 ? detail[..Math.Min(detail.Length, MaxDetail)] : null);
    }
}

/// <summary>
/// git (or ssh) ended with an error: <see cref="ExitCode"/>, its first line as the message, and everything it wrote
/// in <see cref="Detail"/> (what the Git window shows when one of its actions fails).
/// </summary>
internal sealed class GitFailedException(int exitCode, string message, string? detail = null) : IOException(message)
{
    public int ExitCode { get; } = exitCode;

    public string Detail { get; } = detail ?? message;
}

/// <summary>git on this PC.</summary>
internal sealed class LocalGitRunner(IProcessRunner runner) : GitRunner(runner)
{
    public override byte[] Run(string root, IReadOnlyList<string> args) =>
        Collect(new ProcessRequest(GitCommands.Program, [.. Options, .. args]) { WorkingDirectory = root, Environment = Environment }, GitCommands.Program);

    public override Blob ReadFile(string root, string path, long maxBytes, bool keepBytes = false) =>
        Blob.Read(Path.Combine(root, path), maxBytes, keepBytes);

    public override void AppendLine(string root, string path, string line)
    {
        var file = Path.Combine(root, path);
        var text = File.Exists(file) ? File.ReadAllText(file) : "";
        File.AppendAllText(file, (text.Length > 0 && !text.EndsWith('\n') ? "\n" : "") + line + "\n");
    }

    public override string? RootOf(string? folder) => GitStatus.RootOf(folder);

    public override string CheckRoot(string? root)
    {
        if (string.IsNullOrWhiteSpace(root) || !Path.IsPathFullyQualified(root))
        {
            throw new ArgumentException("Not a repository folder.");
        }
        var full = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        var found = GitStatus.RootOf(full);
        if (found is null || !string.Equals(Path.TrimEndingDirectorySeparator(found), full, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            throw new ArgumentException("Not in a git repository.");
        }
        return full;
    }

    public override string CheckPath(string root, string? path)
    {
        var git = base.CheckPath(root, path);
        var full = Path.GetFullPath(Path.Combine(root, git));
        var inside = Path.TrimEndingDirectorySeparator(root) + Path.DirectorySeparatorChar;
        if (!full.StartsWith(inside, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
        {
            throw new ArgumentException("That path isn't in the repository.");
        }
        return git;
    }
}

/// <summary>
/// git on a server, through ssh with an SSH terminal's arguments (its host alias or user@host, port, jump hosts,
/// key). Every call is one ssh run of a single command line, each word single-quoted for the server's shell, so
/// nothing the page sent is read as shell syntax. Without a password helper ssh runs in batch mode: a login that
/// needs a password fails at once rather than waiting unseen.
/// </summary>
internal sealed class SshGitRunner(IProcessRunner runner, string sshArguments, IReadOnlyDictionary<string, string>? environment) : GitRunner(runner)
{
    /// <summary>Roots already checked on each server, so a diff doesn't cost an extra connection each time.</summary>
    private static readonly ConcurrentDictionary<(string Host, string Root), DateTime> Checked = new();
    /// <summary>How long a root stays checked.</summary>
    private static readonly TimeSpan CheckedFor = TimeSpan.FromMinutes(2);
    /// <summary>ssh's own exit code for a failure to connect (anything else is the remote command's).</summary>
    private const int SshFailed = 255;
    /// <summary>The exit code ReadFile's remote command gives for a file that isn't there.</summary>
    private const int NoSuchFile = 3;
    private static readonly string[] TopLevel = [GitCommands.RevParse, GitCommands.Options.ShowTopLevel];

    /// <summary>A word for a POSIX shell: in single quotes, a single quote written as '\''.</summary>
    public static string Quote(string word) => "'" + word.Replace("'", "'\\''") + "'";

    /// <summary>
    /// One argument for a Windows-style command line (which .NET also uses to split ProcessStartInfo.Arguments on
    /// Linux): in double quotes, with backslashes before a quote doubled.
    /// </summary>
    public static string QuoteArgument(string argument)
    {
        var text = new StringBuilder("\"");
        var backslashes = 0;
        foreach (var c in argument)
        {
            if (c == '\\')
            {
                backslashes++;
                continue;
            }
            text.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            backslashes = 0;
            text.Append(c);
        }
        return text.Append('\\', backslashes * 2).Append('"').ToString();
    }

    /// <summary>The ssh command line's arguments for running <paramref name="remoteCommand"/> on the server.</summary>
    public string Arguments(string remoteCommand) =>
        $"-T -o ConnectTimeout=10{(environment is null ? " -o BatchMode=yes" : "")} {sshArguments} {QuoteArgument(remoteCommand)}";

    private byte[] Remote(string command)
    {
        try
        {
            return Collect(new ProcessRequest(SessionProfiles.SshCommand, []) { CommandLine = Arguments(command), Environment = environment }, SessionProfiles.SshCommand);
        }
        catch (GitFailedException e) when (e.ExitCode == SshFailed)
        {
            throw new IOException($"Couldn't connect to the server: {e.Message}");
        }
    }

    /// <summary>git with its options and the environment GitView expects, as one line for the server's shell.</summary>
    public static string GitCommand(string root, IEnumerable<string> args) =>
        string.Concat(Environment.Select(v => $"{v.Key}={v.Value} ")) + GitCommands.Program + " -C " + Quote(root) + " " + string.Join(' ', Options.Concat(args).Select(Quote));

    public override byte[] Run(string root, IReadOnlyList<string> args) => Remote(GitCommand(root, args));

    public override Blob ReadFile(string root, string path, long maxBytes, bool keepBytes = false)
    {
        var file = Quote($"{root.TrimEnd('/')}/{path}");
        byte[] bytes;
        try
        {
            // One byte more than allowed tells a file that's too large; exit 3 one that isn't there.
            bytes = Remote($"if [ -f {file} ]; then head -c {maxBytes + 1} {file}; else exit {NoSuchFile}; fi");
        }
        catch (GitFailedException e) when (e.ExitCode == NoSuchFile)
        {
            return Blob.Missing;
        }
        return bytes.Length > maxBytes ? new Blob(true, null, false, true, bytes.Length) : Blob.From(bytes, maxBytes, keepBytes);
    }

    public override void AppendLine(string root, string path, string line)
    {
        var file = Quote($"{root.TrimEnd('/')}/{path}");
        // A file that doesn't end in a newline gets one first, so the line stays a line of its own.
        Remote($"if [ -s {file} ] && [ -n \"$(tail -c 1 {file})\" ]; then printf '\\n' >> {file}; fi; printf '%s\\n' {Quote(line)} >> {file}");
    }

    public override string? RootOf(string? folder)
    {
        if (!IsServerPath(folder))
        {
            return null;
        }
        try
        {
            var root = Encoding.UTF8.GetString(Run(folder!, TopLevel)).Trim();
            if (root.Length == 0)
            {
                return null;
            }
            Checked[(sshArguments, root)] = DateTime.UtcNow;
            return root;
        }
        catch (GitFailedException e) when (e.ExitCode != SshFailed)
        {
            return null; // git said it isn't a repository
        }
    }

    public override string CheckRoot(string? root)
    {
        if (!IsServerPath(root))
        {
            throw new ArgumentException("Not a repository folder.");
        }
        var trimmed = root!.Length > 1 ? root.TrimEnd('/') : root;
        if (Checked.TryGetValue((sshArguments, trimmed), out var at) && DateTime.UtcNow - at < CheckedFor)
        {
            return trimmed;
        }
        return RootOf(trimmed) == trimmed ? trimmed : throw new ArgumentException("Not in a git repository.");
    }

    /// <summary>An absolute path on the server, on one line.</summary>
    private static bool IsServerPath(string? path) =>
        !string.IsNullOrEmpty(path) && path.StartsWith('/') && !path.Contains('\0') && !path.Contains('\n') && !path.Contains('\r');
}
