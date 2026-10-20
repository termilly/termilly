using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>A changed file the Git window's search found: by its path (<see cref="Line"/> 0), or a line in it.</summary>
/// <param name="Side">Where its change is (one of <see cref="DiffSides"/>); a conflicted file's is unstaged.</param>
internal sealed record GitFileHit(string Path, string Side, string Status, bool Conflict, int Line, string? Text);

/// <summary>A line a commit added or removed that holds what was searched for, and the file it's in.</summary>
internal sealed record GitCodeLine(string Path, bool Added, string Text);

/// <summary>A commit the search found, why (one of <see cref="GitSearchMatches"/>) and, for its code, the lines.</summary>
internal sealed record GitCommitHit(GitCommit Commit, string On, IReadOnlyList<GitCodeLine> Lines);

/// <summary>A tag, with the commit it points at.</summary>
internal sealed record GitTagInfo(string Ref, string Name, string Hash, string Short, string Date, string Subject);

/// <summary>What one search found, but code (<see cref="GitCodeResult"/>, which takes longer).</summary>
internal sealed record GitSearchResult(
    IReadOnlyList<GitFileHit> Files, IReadOnlyList<GitCommitHit> Commits, IReadOnlyList<GitBranchInfo> Branches, IReadOnlyList<GitTagInfo> Tags);

/// <summary>Commits whose changes hold the text, in one batch of history: how far it has searched, and whether there's more.</summary>
internal sealed record GitCodeResult(IReadOnlyList<GitCommitHit> Commits, int Searched, bool More);

/// <summary>Why the search found a commit (GitCommitHit.On).</summary>
internal static class GitSearchMatches
{
    /// <summary>Its hash starts with what was typed.</summary>
    public const string Hash = "hash";
    public const string Message = "message";
    /// <summary>Its author's name or email.</summary>
    public const string Author = "author";
    /// <summary>A line it added or removed.</summary>
    public const string Code = "code";

    public static readonly IReadOnlyList<string> All = [Hash, Message, Author, Code];
}

/// <summary>
/// The Git window's search (js/gitsearch.js): one piece of text, looked for everywhere, ignoring case. Changed files
/// by their paths and inside them (git grep), commits by their hash, message and author, branches and tags by name,
/// and, in batches of history as it takes longer, the lines commits added or removed (git log -G). The text reaches
/// git only as a pattern (after -e, or inside --grep=, --author= and -G as one argument), so never as an option.
/// </summary>
internal static partial class GitSearch
{
    /// <summary>How many commits one code search reads, newest first; the next batch is asked for.</summary>
    public const int CodeBatch = 500;
    /// <summary>The most changed files searched inside, and their paths' length: git grep's command line must fit.</summary>
    private const int MaxGrepPaths = 300;
    private const int MaxGrepChars = 20000;
    private const int MaxFileHits = 200;
    private const int LinesPerFile = 5;
    private const int MaxCommits = 30;
    private const int MaxRefs = 50;
    private const int MaxCodeCommits = 40;
    private const int LinesPerCommit = 3;
    private const int MaxLineChars = 300;
    private const int ShortHash = 7;
    /// <summary>git grep's exit when nothing matched, which isn't an error.</summary>
    private const int NoMatch = 1;
    /// <summary>A line of git grep -z: path, line number, text.</summary>
    private const int GrepFields = 3;
    /// <summary>The status letter the page shows for an untracked file, and a deleted file's (nothing to search inside).</summary>
    private const string UntrackedStatus = "U";
    private const string DeletedStatus = "D";
    /// <summary>A path taken as it is, whatever characters it has (no globs, no pathspec magic).</summary>
    private const string LiteralPath = ":(literal)";
    private const string IgnoreCase = "--regexp-ignore-case";
    private const string FixedStrings = "--fixed-strings";
    private const string NoFile = "/dev/null";
    private const string DiffHead = "diff ";
    private const string HunkHead = "@@";
    private const string OldFile = "--- ";
    private const string NewFile = "+++ ";

    /// <summary>Each commit's fields between <see cref="GitOutput.Record"/> and one more <see cref="GitOutput.Unit"/>, then its patch.</summary>
    private static readonly string CodeFormat = $"--format={GitOutput.Record}{GitOutput.LogFieldsFormat}{GitOutput.Unit}";
    private static readonly string TagFormat = $"--format=%(refname){GitOutput.Unit}%(refname:short){GitOutput.Unit}%(objectname){GitOutput.Unit}%(*objectname){GitOutput.Unit}%(creatordate:iso-strict){GitOutput.Unit}%(subject)";

    /// <summary>The fields of <see cref="TagFormat"/>, in order; Peeled is an annotated tag's commit.</summary>
    private enum TagField { Ref, Name, Object, Peeled, Date, Subject }

    /// <summary>What a basic regular expression (git log -G) reads as more than itself.</summary>
    [GeneratedRegex(@"[.\[\]\\*^$]")]
    private static partial Regex RegexSpecial();

    /// <summary>What to look for: the query's first line, trimmed; null for nothing.</summary>
    private static string? Needle(string? query)
    {
        var text = query?.Split('\n')[0].Trim();
        return string.IsNullOrEmpty(text) ? null : text;
    }

    public static GitSearchResult Search(string root, string? query, GitRunner git)
    {
        if (Needle(query) is not { } text)
        {
            return new GitSearchResult([], [], [], []);
        }
        var branches = GitView.Branches(root, git).Where(b => b.Name.Contains(text, StringComparison.OrdinalIgnoreCase)).Take(MaxRefs).ToList();
        return new GitSearchResult(Files(root, text, git), Commits(root, text, git), branches, Tags(root, text, git));
    }

    // ---- Changed files ----

    private static List<GitFileHit> Files(string root, string text, GitRunner git)
    {
        var tree = GitOutput.Status(root, GitView.Text(git, root, GitView.StatusCommand));
        // A file in more than one list is shown from the one that matters most: a conflict, then what's on disk, then the index.
        var files = new Dictionary<string, GitFileHit>(StringComparer.Ordinal);
        void Add(IReadOnlyList<GitFile> list, string side, bool conflict, string? status = null)
        {
            foreach (var f in list)
            {
                files.TryAdd(f.Path, new GitFileHit(f.Path, side, status ?? f.Status, conflict, 0, null));
            }
        }
        Add(tree.Conflicted, DiffSides.Unstaged, conflict: true);
        Add(tree.Unstaged, DiffSides.Unstaged, conflict: false);
        Add(tree.Untracked, DiffSides.Untracked, conflict: false, UntrackedStatus);
        Add(tree.Staged, DiffSides.Staged, conflict: false);
        var hits = files.Values.Where(f => f.Path.Contains(text, StringComparison.OrdinalIgnoreCase)).ToList();
        hits.AddRange(Grep(root, text, files, git));
        return hits.Take(MaxFileHits).ToList();
    }

    /// <summary>The lines of the changed files (as they are on disk) that hold the text, a few per file.</summary>
    private static List<GitFileHit> Grep(string root, string text, Dictionary<string, GitFileHit> files, GitRunner git)
    {
        var args = new List<string> { GitCommands.Grep, "--line-number", "-I", "--ignore-case", FixedStrings, GitCommands.Options.NulTerminated, "--untracked", "-e", text, GitCommands.Options.Paths };
        var first = args.Count;
        var length = 0;
        foreach (var f in files.Values.Where(f => f.Status != DeletedStatus).Take(MaxGrepPaths))
        {
            length += f.Path.Length + LiteralPath.Length;
            if (length > MaxGrepChars)
            {
                break;
            }
            args.Add(LiteralPath + f.Path);
        }
        if (args.Count == first)
        {
            return [];
        }
        string raw;
        try
        {
            raw = GitView.Text(git, root, [.. args]);
        }
        catch (GitFailedException e) when (e.ExitCode == NoMatch)
        {
            return [];
        }
        // Each line: path NUL line number NUL text.
        return raw.Split('\n').Select(l => l.Split('\0', GrepFields)).Where(p => p.Length == GrepFields && files.ContainsKey(p[0]))
            .GroupBy(p => p[0]).SelectMany(g => g.Take(LinesPerFile))
            .Select(p => files[p[0]] with { Line = int.TryParse(p[1], out var n) ? n : 0, Text = Clip(p[2]) }).ToList();
    }

    private static string Clip(string line)
    {
        var text = line.Trim();
        return text.Length > MaxLineChars ? text[..MaxLineChars] : text;
    }

    // ---- Commits, tags ----

    /// <summary>The commit whose hash starts with the text, then those whose message holds it, then its author's.</summary>
    private static List<GitCommitHit> Commits(string root, string text, GitRunner git)
    {
        var hits = new List<GitCommitHit>();
        var hash = text.ToLowerInvariant();
        if (GitView.LooksLikeHash(hash) && GitView.FindCommit(git, root, hash) is { } commit)
        {
            hits.Add(new GitCommitHit(commit, GitSearchMatches.Hash, []));
        }
        foreach (var (option, on) in new[] { ("--grep=", GitSearchMatches.Message), ("--author=", GitSearchMatches.Author) })
        {
            var found = GitView.ReadLog(git, root, [GitCommands.Log, GitOutput.LogFormat, GitView.FullDecorations, $"-n{MaxCommits}", IgnoreCase, FixedStrings, option + text])
                .Where(c => !hits.Exists(h => h.Commit.Hash == c.Hash)).ToList();
            hits.AddRange(found.Select(c => new GitCommitHit(c, on, [])));
        }
        return hits;
    }

    private static List<GitTagInfo> Tags(string root, string text, GitRunner git) =>
        GitView.Text(git, root, GitCommands.ForEachRef, TagFormat, "--sort=-creatordate", GitCommands.Refs.Tags)
            .Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(l => l.TrimEnd('\r').Split(GitOutput.Unit))
            .Where(f => f.Length > (int)TagField.Subject && f[(int)TagField.Name].Contains(text, StringComparison.OrdinalIgnoreCase))
            .Take(MaxRefs).Select(f =>
            {
                var hash = f[(int)TagField.Peeled].Length > 0 ? f[(int)TagField.Peeled] : f[(int)TagField.Object];
                return new GitTagInfo(f[(int)TagField.Ref], f[(int)TagField.Name], hash, hash[..Math.Min(ShortHash, hash.Length)], f[(int)TagField.Date], f[(int)TagField.Subject]);
            }).ToList();

    // ---- Code ----

    /// <summary>
    /// The commits among one batch of history (<see cref="CodeBatch"/> commits from HEAD, after <paramref name="batch"/>
    /// batches) that added or removed a line holding the text, with those lines.
    /// </summary>
    public static GitCodeResult SearchCode(string root, string? query, int batch, GitRunner git)
    {
        var start = Math.Max(0, batch) * CodeBatch;
        if (Needle(query) is not { } text)
        {
            return new GitCodeResult([], start, false);
        }
        var commits = GitView.ReadLog(git, root, [GitCommands.Log, GitOutput.LogFormat, $"--skip={start}", $"-n{CodeBatch + 1}"]);
        if (commits.Count == 0)
        {
            return new GitCodeResult([], start, false);
        }
        var more = commits.Count > CodeBatch;
        var args = new List<string> { GitCommands.Log, CodeFormat, GitView.FullDecorations, $"-n{MaxCodeCommits}", IgnoreCase,
            $"-G{RegexSpecial().Replace(text, @"\$0")}", "-p", "--unified=0", "--no-prefix", "--no-ext-diff", GitView.CheckHash(commits[0].Hash) };
        if (more)
        {
            args.Add("^" + GitView.CheckHash(commits[CodeBatch].Hash));
        }
        return new GitCodeResult(ReadCode(GitView.Text(git, root, [.. args]), text), start + Math.Min(commits.Count, CodeBatch), more);
    }

    private static List<GitCommitHit> ReadCode(string raw, string text) =>
        raw.Split(GitOutput.Record).Select(r => r.Split(GitOutput.Unit, GitOutput.LogFields + 1))
            .Where(f => f.Length > GitOutput.LogFields)
            .Select(f => new GitCommitHit(GitOutput.Commit(f), GitSearchMatches.Code, CodeLines(f[GitOutput.LogFields], text))).ToList();

    /// <summary>A patch's added and removed lines that hold the text, a few, with their files.</summary>
    private static List<GitCodeLine> CodeLines(string patch, string text)
    {
        var lines = new List<GitCodeLine>();
        var path = "";
        var inHead = false; // a file's head (diff, index, ---, +++) until its first hunk
        foreach (var raw in patch.Split('\n'))
        {
            var line = raw.TrimEnd('\r');
            if (line.StartsWith(DiffHead, StringComparison.Ordinal))
            {
                inHead = true;
            }
            else if (line.StartsWith(HunkHead, StringComparison.Ordinal))
            {
                inHead = false;
            }
            else if (inHead)
            {
                if ((line.StartsWith(NewFile, StringComparison.Ordinal) || line.StartsWith(OldFile, StringComparison.Ordinal)) && line[OldFile.Length..] != NoFile)
                {
                    path = line[OldFile.Length..];
                }
            }
            else if (lines.Count < LinesPerCommit && line.Length > 1 && line[0] is '+' or '-' && line.Contains(text, StringComparison.OrdinalIgnoreCase))
            {
                lines.Add(new GitCodeLine(path, line[0] == '+', Clip(line[1..])));
            }
        }
        return lines;
    }
}
