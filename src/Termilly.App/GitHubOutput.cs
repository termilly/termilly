using System.Globalization;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

internal sealed record GitHubAddress(string Url, int Number);

internal static partial class GitHubOutput
{
    internal static bool IsGitHubRemote(string remote) => GitHubRemote().IsMatch(remote.Trim());

    /// <summary>The repository a GitHub remote names ("owner/name"), or null when it names none.</summary>
    internal static string? RepoName(string remote) =>
        GitHubRepo().Match(remote.Trim()) is { Success: true } m ? $"{m.Groups[1].Value}/{m.Groups[2].Value}" : null;

    internal static GitHubAddress? ParseAddress(string output, bool pullRequest = false)
    {
        var match = (pullRequest ? PullUrl() : IssueUrl()).Matches(output).LastOrDefault();
        return match is not null && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            ? new(match.Value, number) : null;
    }

    [GeneratedRegex(@"^(https://|ssh://git@|git@)github\.com[/:]", RegexOptions.IgnoreCase)]
    private static partial Regex GitHubRemote();

    [GeneratedRegex(@"^(?:https://|ssh://git@|git@)github\.com[/:]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$", RegexOptions.IgnoreCase)]
    private static partial Regex GitHubRepo();

    [GeneratedRegex(@"https://\S+/issues/(\d+)")]
    private static partial Regex IssueUrl();

    [GeneratedRegex(@"https://\S+/pull/(\d+)")]
    private static partial Regex PullUrl();
}
