using System.IO;

namespace Termilly.Desktop.Services;

/// <summary>
/// git in a folder on this PC, for what isn't the Git window (which has <see cref="GitRunner"/>): agent worktrees,
/// the sidebar's project status and the change preview's copies from HEAD.
/// </summary>
internal sealed class LocalGit(IProcessRunner runner)
{
    private const string Git = "git";
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(2);
    /// <summary>A raw read (a file at HEAD) is a quick one: it gives up sooner.</summary>
    private static readonly TimeSpan RawTimeout = TimeSpan.FromSeconds(10);

    /// <summary>git's output, trimmed; IOException with git's own message when it fails.</summary>
    public string Text(string directory, params string[] args)
    {
        var result = runner.Run(new ProcessRequest(Git, args) { WorkingDirectory = directory, Timeout = Timeout });
        return result.Succeeded
            ? result.Text.TrimEnd()
            : throw new IOException(result.FirstErrorLine ?? $"git failed ({result.ExitCode}).");
    }

    /// <summary>
    /// git's output byte for byte (<see cref="Text"/> trims it, which would lose a file's last newline), or null when
    /// git fails, isn't there, or writes more than <paramref name="maxBytes"/>.
    /// </summary>
    public byte[]? Raw(string directory, int maxBytes, params string[] args)
    {
        try
        {
            var result = runner.Run(new ProcessRequest(Git, args) { WorkingDirectory = directory, Timeout = RawTimeout, MaxOutputBytes = maxBytes });
            return result is { Succeeded: true, Truncated: false } ? result.Output : null;
        }
        catch (IOException)
        {
            return null;
        }
    }
}
