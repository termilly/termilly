using System.Globalization;
using System.IO;
using System.Text.RegularExpressions;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Features;

/// <summary>
/// The words of the compact view's lines, the same for Claude Code and Codex: a path as it reads from the session's
/// folder, a command cut to its first line, a test run's result, a patch's counts, how long a turn took.
/// </summary>
internal static partial class CompactText
{
    /// <summary>The words of a reply or a prompt are cut to this (the view shows the start; a reply this long is rare).</summary>
    public const int MaxWords = 4000;
    /// <summary>What a tool worked on is cut to this.</summary>
    public const int MaxSubject = 300;
    /// <summary>A failed tool's reason is cut to this.</summary>
    private const int MaxReason = 80;
    private const int SecondsPerMinute = 60;
    private const int MinutesPerHour = 60;
    private const char Ellipsis = '…';

    /// <summary>What a step that worked says when there's nothing to count.</summary>
    public const string Done = "done";
    /// <summary>What a step that failed says when it gives no reason.</summary>
    public const string Failed = "failed";

    /// <summary>"412 lines".</summary>
    public static string LineCount(long n) => Count(n, "line", "lines");

    /// <summary>"3 files".</summary>
    public static string FileCount(long n) => Count(n, "file", "files");

    /// <summary>"12 hits": a search's matches.</summary>
    public static string HitCount(long n) => Count(n, "hit", "hits");

    /// <summary>Cut to at most <paramref name="max"/> characters, with an ellipsis when something was left out.</summary>
    public static string Cut(string text, int max) => text.Length <= max ? text : string.Concat(text.AsSpan(0, max - 1), Ellipsis.ToString());

    /// <summary>The first line that isn't blank, cut to <paramref name="max"/>; empty for none.</summary>
    public static string FirstLine(string? text, int max = MaxSubject)
    {
        foreach (var line in (text ?? "").Split('\n'))
        {
            if (!string.IsNullOrWhiteSpace(line))
            {
                return Cut(line.Trim(), max);
            }
        }
        return "";
    }

    /// <summary>Why a tool failed: its result's first line, short.</summary>
    public static string Reason(string? text) => FirstLine(text, MaxReason);

    /// <summary>How many lines a text has (a last line without its newline counts); 0 for none.</summary>
    public static int Lines(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return 0;
        }
        var count = text.Count(c => c == '\n');
        return text.EndsWith('\n') ? count : count + 1;
    }

    /// <summary>How many lines that aren't blank a text has (a search's hits, a listing's entries).</summary>
    public static int Entries(string? text) => (text ?? "").Split('\n').Count(l => !string.IsNullOrWhiteSpace(l));

    /// <summary>"1 line", "12 lines": a count with its word.</summary>
    public static string Count(long n, string one, string many) => $"{n.ToString(CultureInfo.InvariantCulture)} {(n == 1 ? one : many)}";

    /// <summary>A path as it reads from the session's folder: relative when it's inside it, else as it is.</summary>
    public static string Relative(string? path, string? cwd)
    {
        if (string.IsNullOrEmpty(path))
        {
            return "";
        }
        if (string.IsNullOrEmpty(cwd))
        {
            return path;
        }
        // Codex writes D:/work/app where its folder is D:\work\app: the separators are made the same to compare.
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var folder = cwd.Replace('\\', '/').TrimEnd('/');
        var file = path.Replace('\\', '/');
        if (file.Length > folder.Length + 1 && file.StartsWith(folder, comparison) && file[folder.Length] == '/')
        {
            return file[(folder.Length + 1)..];
        }
        return path;
    }

    /// <summary>A patch's counts: "+9 -2", "+4", "-3"; null when it changes no lines.</summary>
    public static string? Changes(int added, int removed) => (added, removed) switch
    {
        (0, 0) => null,
        (_, 0) => $"+{added}",
        (0, _) => $"-{removed}",
        _ => $"+{added} -{removed}",
    };

    /// <summary>The lines a unified diff adds and removes (its file headers aren't changes).</summary>
    public static (int Added, int Removed) DiffCounts(string? diff)
    {
        var (added, removed) = (0, 0);
        foreach (var line in (diff ?? "").Split('\n'))
        {
            if (line.StartsWith("+++", StringComparison.Ordinal) || line.StartsWith("---", StringComparison.Ordinal))
            {
                continue;
            }
            if (line.StartsWith('+'))
            {
                added++;
            }
            else if (line.StartsWith('-'))
            {
                removed++;
            }
        }
        return (added, removed);
    }

    /// <summary>A command that runs tests (its line then says Test, with what passed and failed).</summary>
    public static bool IsTest(string command) => TestCommand().IsMatch(command);

    /// <summary>The verb for a command: Test for a test run, else Run.</summary>
    public static string CommandVerb(string command) => IsTest(command) ? CompactVerbs.Test : CompactVerbs.Run;

    /// <summary>
    /// What a test run's output says: "41 passed", "2 failed · 39 passed"; null when it says neither (the line then
    /// says whether the command succeeded).
    /// </summary>
    public static string? TestResult(string? output)
    {
        if (string.IsNullOrEmpty(output))
        {
            return null;
        }
        var passed = Last(PassedCount(), output);
        var failed = Last(FailedCount(), output);
        return (passed, failed) switch
        {
            (null, null) => null,
            (_, null or 0) => $"{passed} passed",
            (null, _) => $"{failed} failed",
            _ => $"{failed} failed · {passed} passed",
        };
    }

    /// <summary>What a command's output comes to: a test run's result, else how many lines it printed.</summary>
    public static string Output(string command, string? output) =>
        (IsTest(command) ? TestResult(output) : null) ?? (Lines(output) == 0 ? Done : LineCount(Lines(output)));

    /// <summary>The number in the last match of a pattern (whichever group matched): a summary comes after the runs it sums up.</summary>
    private static int? Last(Regex pattern, string text)
    {
        int? found = null;
        foreach (Match m in pattern.Matches(text))
        {
            var group = m.Groups.Values.Skip(1).FirstOrDefault(g => g.Success);
            if (group is not null && int.TryParse(group.ValueSpan, NumberStyles.None, CultureInfo.InvariantCulture, out var n))
            {
                found = n;
            }
        }
        return found;
    }

    /// <summary>How long a turn took: "41s", "2m 14s", "1h 5m".</summary>
    public static string Duration(long milliseconds)
    {
        var time = TimeSpan.FromMilliseconds(Math.Max(0, milliseconds));
        var seconds = (long)time.TotalSeconds;
        if (seconds < SecondsPerMinute)
        {
            return $"{seconds}s";
        }
        var minutes = seconds / SecondsPerMinute;
        return minutes < MinutesPerHour
            ? $"{minutes}m {seconds % SecondsPerMinute}s"
            : $"{minutes / MinutesPerHour}h {minutes % MinutesPerHour}m";
    }

    /// <summary>A path's last part, its file name.</summary>
    public static string FileName(string? path) => string.IsNullOrEmpty(path) ? "" : Path.GetFileName(path.TrimEnd('/', '\\'));

    [GeneratedRegex(@"(?:^|[\s;&|(])(?:dotnet\s+test|npm\s+(?:run\s+)?test|yarn\s+test|pnpm\s+(?:run\s+)?test|npx\s+(?:jest|vitest|playwright\s+test)|jest|vitest|pytest|python3?\s+-m\s+(?:pytest|unittest)|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|node\s+--test|bun\s+test|deno\s+test|rspec|phpunit)\b")]
    private static partial Regex TestCommand();

    /// <summary>"41 passed", "Passed: 41" (dotnet), "# pass 41" (node), "41 passing" (mocha).</summary>
    [GeneratedRegex(@"(\d+)\s+pass(?:ed|ing)\b|Passed:\s*(\d+)|#\s*pass\s+(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex PassedCount();

    /// <summary>"2 failed", "Failed: 2" (dotnet), "# fail 2" (node), "2 failing" (mocha).</summary>
    [GeneratedRegex(@"(\d+)\s+fail(?:ed|ing)\b|Failed:\s*(\d+)|#\s*fail\s+(\d+)", RegexOptions.IgnoreCase)]
    private static partial Regex FailedCount();
}
