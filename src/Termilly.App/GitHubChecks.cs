using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Shared;

namespace Termilly.Desktop;

internal static class GitHubRunStatus
{
    public const string Queued = "queued";
    public const string InProgress = "in_progress";
    public const string Completed = "completed";
    public const string Waiting = "waiting";
    public const string Requested = "requested";
    public const string Pending = "pending";
    public static readonly IReadOnlyList<string> All = [Queued, InProgress, Completed, Waiting, Requested, Pending];
}

internal static class GitHubRunConclusion
{
    public const string Success = "success";
    public const string Failure = "failure";
    public const string Cancelled = "cancelled";
    public const string Skipped = "skipped";
    public const string TimedOut = "timed_out";
    public const string ActionRequired = "action_required";
    public const string Neutral = "neutral";
    public const string StartupFailure = "startup_failure";
    public static readonly IReadOnlyList<string> All = [Success, Failure, Cancelled, Skipped, TimedOut, ActionRequired, Neutral, StartupFailure];
}

internal sealed record GitHubRun(long Id, string Workflow, string Title, string Status, string? Conclusion, string Event, string Branch, string HeadSha, string Url, string CreatedAt);
internal sealed record GitHubJob(long Id, string Name, string Status, string? Conclusion, string Url, string? FailedStep);
internal sealed record GitHubFailedLog(string Text, string Url, bool Cut);

internal sealed partial class GitHub
{
    private const string ConclusionField = "conclusion";
    private const int ContinuationMask = 0xC0;
    private const int ContinuationByte = 0x80;
    private const string RunCommand = "run";
    private const string JobsField = "jobs";
    private const string RunFields = "databaseId,workflowName,displayTitle,status,conclusion,event,headBranch,headSha,url,createdAt";
    private const int MaxRuns = 100;
    private const int MaxLogLines = 400;
    private const int MaxLogBytes = 64 * 1024;

    public IReadOnlyList<GitHubRun> Runs(string root, string? branch)
    {
        var nodes = Parse(Checked(git.CheckRoot(root), RunsArguments(branch))).AsArray();
        return nodes.Select(n => new GitHubRun(Id(n!), Text(n!, "workflowName"), Text(n!, "displayTitle"), Text(n!, GitHubWords.Status),
            Optional(n!, ConclusionField), Text(n!, "event"), Text(n!, "headBranch"), Text(n!, "headSha"), Text(n!, GitHubWords.Url), Text(n!, "createdAt")))
            .OrderByDescending(r => r.CreatedAt, StringComparer.Ordinal).Take(MaxRuns).ToList();
    }

    internal static IReadOnlyList<string> RunsArguments(string? branch)
    {
        var args = new List<string> { RunCommand, GitHubWords.List, GitHubWords.Limit, MaxRuns.ToString(CultureInfo.InvariantCulture), GitHubWords.Json, RunFields };
        if (branch is not null)
        {
            args.AddRange(["--branch", Required(branch)]);
        }
        return args;
    }

    public IReadOnlyList<GitHubJob> RunJobs(string root, long runId)
    {
        var nodes = Parse(Checked(git.CheckRoot(root), [RunCommand, GitHubWords.View, RunNumber(runId), GitHubWords.Json, JobsField]))[JobsField]?.AsArray() ?? throw new JsonException("GitHub returned no jobs.");
        return nodes.Select(n => new GitHubJob(Id(n!), Text(n!, GitHubWords.Name), Text(n!, GitHubWords.Status), Optional(n!, ConclusionField), Text(n!, GitHubWords.Url),
            n!["steps"]?.AsArray().FirstOrDefault(s => Optional(s!, ConclusionField) == GitHubRunConclusion.Failure)?[GitHubWords.Name].AsText())).ToList();
    }

    public GitHubFailedLog FailedLog(string root, long runId, long? jobId)
    {
        root = git.CheckRoot(root);
        var number = RunNumber(runId);
        var url = Text(Parse(Checked(root, [RunCommand, GitHubWords.View, number, GitHubWords.Json, GitHubWords.Url])), GitHubWords.Url);
        var args = new List<string> { RunCommand, GitHubWords.View, number, "--log-failed" };
        if (jobId is not null)
        {
            args.AddRange(["--job", RunNumber(jobId.Value)]);
        }
        return TrimLog(Checked(root, args), url);
    }

    internal static GitHubFailedLog TrimLog(string text, string url)
    {
        var lines = text.Replace("\r\n", "\n", StringComparison.Ordinal).Split('\n');
        var cut = lines.Length > MaxLogLines;
        var tail = string.Join('\n', lines.TakeLast(MaxLogLines));
        var bytes = Encoding.UTF8.GetBytes(tail);
        if (bytes.Length > MaxLogBytes)
        {
            var start = bytes.Length - MaxLogBytes;
            // Start on a code point so a truncated Unicode log stays valid text.
            while (start < bytes.Length && (bytes[start] & ContinuationMask) == ContinuationByte)
            {
                start++;
            }
            tail = Encoding.UTF8.GetString(bytes, start, bytes.Length - start);
            cut = true;
        }
        return new GitHubFailedLog(tail, url, cut);
    }

    public void RerunFailed(string root, long runId) =>
        Checked(git.CheckRoot(root), [RunCommand, "rerun", RunNumber(runId), "--failed"]);

    private static string RunNumber(long number) => number > 0 ? number.ToString(CultureInfo.InvariantCulture) : throw new ArgumentException("Invalid run or job number.");
    private static long Id(JsonNode? node) => node?["databaseId"].AsLong() ?? throw new JsonException("GitHub returned no run or job id.");
    private static string Text(JsonNode? node, string key) => node?[key].AsText() ?? throw new JsonException("GitHub returned an invalid text field.");
    private static string? Optional(JsonNode? node, string key) => node?[key].AsText() is { Length: > 0 } text ? text : null;
}
