using System.Globalization;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

internal sealed record GitHubAddress(string Url, int Number);

internal static partial class GitHubOutput
{
    internal static bool IsGitHubRemote(string remote) => GitHubRemote().IsMatch(remote.Trim());

    internal static GitHubAddress? ParseAddress(string output, bool pullRequest = false)
    {
        var match = (pullRequest ? PullUrl() : IssueUrl()).Matches(output).LastOrDefault();
        return match is not null && int.TryParse(match.Groups[1].Value, NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            ? new(match.Value, number) : null;
    }

    [GeneratedRegex(@"^(https://|ssh://git@|git@)github\.com[/:]", RegexOptions.IgnoreCase)]
    private static partial Regex GitHubRemote();

    [GeneratedRegex(@"https://\S+/issues/(\d+)")]
    private static partial Regex IssueUrl();

    [GeneratedRegex(@"https://\S+/pull/(\d+)")]
    private static partial Regex PullUrl();
}
