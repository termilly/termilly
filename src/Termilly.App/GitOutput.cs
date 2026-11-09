using System.IO;

namespace Termilly.Desktop;

/// <summary>
/// Reads what the Git window's git commands print (GitView runs them): status, log, a commit's files and the branch
/// list. The formats that are Termilly's own separate fields with <see cref="Unit"/> and records with
/// <see cref="Record"/>, characters no path, name or subject has.
/// </summary>
internal static class GitOutput
{
    public const char Unit = '\x1f';
    public const char Record = '\x1e';
    private const string HeadsPrefix = GitCommands.Refs.HeadsPrefix;
    private const string RemotesPrefix = GitCommands.Refs.RemotesPrefix;
    private const string TagsPrefix = GitCommands.Refs.TagsPrefix;
    private const string HeadArrow = "HEAD -> ";
    private const string TagDecoration = "tag: ";

    // ---- git status --porcelain=v2 -z --branch ----

    private const string BranchOid = "# branch.oid ";
    private const string BranchHead = "# branch.head ";
    private const string BranchUpstream = "# branch.upstream ";
    private const string BranchAheadBehind = "# branch.ab ";
    private const string NoCommits = "# branch.oid (initial)";
    private const string Detached = "(detached)";
    private const string ChangedEntry = "1 ";
    private const string RenamedEntry = "2 ";
    private const string ConflictEntry = "u ";
    private const string UntrackedEntry = "? ";
    private static readonly string[] FileEntries = [ChangedEntry, RenamedEntry, ConflictEntry, UntrackedEntry];

    /// <summary>A status line about a file (changed, renamed, in conflict or untracked), not the branch.</summary>
    public static bool IsFileEntry(string line) => FileEntries.Any(entry => line.StartsWith(entry, StringComparison.Ordinal));
    /// <summary>The fields of a changed entry (1 XY sub mH mI mW hH hI path), a renamed one (… Xscore path) and a conflict.</summary>
    private const int ChangedFields = 9;
    private const int RenamedFields = 10;
    private const int ConflictFields = 11;
    private const char Unchanged = '.';
    private const string ConflictLetter = "U";
    private const string UntrackedLetter = "?";

    /// <summary>Reads <c>git status --porcelain=v2 -z --branch</c>.</summary>
    public static GitWorkingTree Status(string root, string raw)
    {
        var header = new StatusHeader();
        var files = new StatusFiles();
        var entries = raw.Split('\0');
        for (var i = 0; i < entries.Length; i++)
        {
            var e = entries[i];
            if (header.Read(e))
            {
                continue;
            }
            if (e.StartsWith(ChangedEntry, StringComparison.Ordinal) || e.StartsWith(RenamedEntry, StringComparison.Ordinal))
            {
                // A rename's old path is the next entry.
                var renamed = e.StartsWith(RenamedEntry, StringComparison.Ordinal);
                files.AddChanged(e.Split(' ', renamed ? RenamedFields : ChangedFields), renamed && i + 1 < entries.Length ? entries[++i] : null);
            }
            else if (e.StartsWith(ConflictEntry, StringComparison.Ordinal))
            {
                files.Conflicted.Add(new GitFile(e.Split(' ', ConflictFields)[^1], null, ConflictLetter));
            }
            else if (e.StartsWith(UntrackedEntry, StringComparison.Ordinal))
            {
                files.Untracked.Add(new GitFile(e[UntrackedEntry.Length..], null, UntrackedLetter));
            }
        }
        return new GitWorkingTree(root, Path.GetFileName(Path.TrimEndingDirectorySeparator(root)), header.ShownBranch, header.Detached,
            header.Upstream, header.Ahead, header.Behind, header.HasCommits, files.Staged, files.Unstaged, files.Untracked, files.Conflicted);
    }

    /// <summary>The "# branch.*" lines at the top of the status (GitStatus reads them too).</summary>
    public sealed class StatusHeader
    {
        public string? Branch { get; private set; }

        /// <summary>No branch is checked out: HEAD is a commit.</summary>
        public bool Detached => Branch == GitOutput.Detached;

        /// <summary>The branch, or null when detached.</summary>
        public string? ShownBranch => Detached ? null : Branch;
        public string? Upstream { get; private set; }
        public int Ahead { get; private set; }
        public int Behind { get; private set; }
        public bool HasCommits { get; private set; } = true;

        /// <summary>Takes in a header line; false for any other entry.</summary>
        public bool Read(string e)
        {
            if (e.StartsWith(BranchOid, StringComparison.Ordinal))
            {
                HasCommits = e != NoCommits;
            }
            else if (e.StartsWith(BranchHead, StringComparison.Ordinal))
            {
                Branch = e[BranchHead.Length..];
            }
            else if (e.StartsWith(BranchUpstream, StringComparison.Ordinal))
            {
                Upstream = e[BranchUpstream.Length..];
            }
            else if (e.StartsWith(BranchAheadBehind, StringComparison.Ordinal))
            {
                ReadAheadBehind(e[BranchAheadBehind.Length..]);
            }
            else
            {
                return false;
            }
            return true;
        }

        /// <summary>"+2 -1": two commits ahead of the upstream, one behind.</summary>
        private void ReadAheadBehind(string counts)
        {
            foreach (var part in counts.Split(' '))
            {
                if (part.Length > 1 && int.TryParse(part[1..], out var n))
                {
                    if (part[0] == '+')
                    {
                        Ahead = n;
                    }
                    else if (part[0] == '-')
                    {
                        Behind = n;
                    }
                }
            }
        }
    }

    /// <summary>The status's files, by the list the Changes tab shows them in.</summary>
    private sealed class StatusFiles
    {
        public List<GitFile> Staged { get; } = [];
        public List<GitFile> Unstaged { get; } = [];
        public List<GitFile> Untracked { get; } = [];
        public List<GitFile> Conflicted { get; } = [];

        /// <summary>A changed or renamed entry: staged when its X letter says so, unstaged when its Y does (both can).</summary>
        public void AddChanged(string[] fields, string? oldPath)
        {
            var xy = fields[1];
            var path = fields[^1];
            if (xy[0] != Unchanged)
            {
                Staged.Add(new GitFile(path, xy[0] is 'R' or 'C' ? oldPath : null, xy[0].ToString()));
            }
            if (xy[1] != Unchanged)
            {
                Unstaged.Add(new GitFile(path, null, xy[1].ToString()));
            }
        }
    }

    // ---- git log ----

    /// <summary>
    /// A commit's fields as <see cref="LogFormat"/> prints them (hash, short hash, parents, author, date, subject,
    /// decorations), for a format that puts more around them. It comes first: LogFormat is made from it.
    /// </summary>
    public static readonly string LogFieldsFormat = $"%H{Unit}%h{Unit}%P{Unit}%an{Unit}%aI{Unit}%s{Unit}%D";

    /// <summary>The log format <see cref="Log"/> reads.</summary>
    public static readonly string LogFormat = $"--format={LogFieldsFormat}{Record}";

    /// <summary>The fields of <see cref="LogFormat"/>, in order.</summary>
    private enum LogField { Hash, Short, Parents, Author, Date, Subject, Refs }

    /// <summary>How many fields <see cref="LogFormat"/> has.</summary>
    public const int LogFields = (int)LogField.Refs + 1;

    public static IReadOnlyList<GitCommit> Log(string raw) =>
        raw.Split(Record).Select(r => r.Trim('\n', '\r')).Where(r => r.Length > 0).Select(r => Commit(r.Split(Unit))).ToList();

    /// <summary>A commit from <see cref="LogFormat"/>'s fields, in order.</summary>
    public static GitCommit Commit(IReadOnlyList<string> f)
    {
        var refs = f.Count > (int)LogField.Refs && f[(int)LogField.Refs].Length > 0 ? f[(int)LogField.Refs].Split(", ").Select(ShortRef).ToList() : [];
        return new GitCommit(f[(int)LogField.Hash], f[(int)LogField.Short], f[(int)LogField.Parents].Split(' ', StringSplitOptions.RemoveEmptyEntries),
            f[(int)LogField.Author], f[(int)LogField.Date], f[(int)LogField.Subject], refs);
    }

    /// <summary>"HEAD -> refs/heads/main" as "HEAD -> main", "refs/tags/v1" as "tag: v1", "refs/remotes/o/x" as "remote: o/x".</summary>
    public static string ShortRef(string d)
    {
        if (d.StartsWith(HeadArrow, StringComparison.Ordinal))
        {
            return HeadArrow + ShortRef(d[HeadArrow.Length..]);
        }
        if (d.StartsWith(TagDecoration + TagsPrefix, StringComparison.Ordinal))
        {
            return TagDecoration + d[(TagDecoration.Length + TagsPrefix.Length)..];
        }
        if (d.StartsWith(HeadsPrefix, StringComparison.Ordinal))
        {
            return d[HeadsPrefix.Length..];
        }
        if (d.StartsWith(RemotesPrefix, StringComparison.Ordinal))
        {
            return "remote: " + d[RemotesPrefix.Length..];
        }
        if (d.StartsWith(TagsPrefix, StringComparison.Ordinal))
        {
            return TagDecoration + d[TagsPrefix.Length..];
        }
        return d;
    }

    // ---- One commit: git show, then git diff-tree -z --name-status and --numstat ----

    /// <summary>The commit format <see cref="CommitHead"/> reads: hash, parents, author, date, committer, date, message.</summary>
    public static readonly string CommitFormat = $"--format=%H{Unit}%P{Unit}%an{Unit}%aI{Unit}%cn{Unit}%cI{Unit}%B";

    /// <summary>The fields of <see cref="CommitFormat"/>, in order.</summary>
    private enum CommitField { Hash, Parents, Author, AuthorDate, Committer, CommitDate, Message, Count }

    /// <summary>A commit's details from <see cref="CommitFormat"/>, without its files yet.</summary>
    public static GitCommitDetail CommitHead(string raw)
    {
        var f = raw.Split(Unit, (int)CommitField.Count);
        return new GitCommitDetail(f[(int)CommitField.Hash], f[(int)CommitField.Parents].Split(' ', StringSplitOptions.RemoveEmptyEntries),
            f[(int)CommitField.Author], f[(int)CommitField.AuthorDate], f[(int)CommitField.Committer], f[(int)CommitField.CommitDate],
            f[(int)CommitField.Message].TrimEnd(), []);
    }

    /// <summary>Joins <c>diff-tree -z --name-status</c> and <c>--numstat</c> into one list.</summary>
    public static IReadOnlyList<GitCommitFile> CommitFiles(string nameStatus, string numstat)
    {
        var counts = LineCounts(numstat);
        var files = new List<GitCommitFile>();
        var s = nameStatus.Split('\0');
        for (var i = 0; i + 1 < s.Length; i++)
        {
            var code = s[i];
            if (code.Length == 0)
            {
                continue;
            }
            string? old = null;
            if (code[0] is 'R' or 'C' && i + 2 < s.Length)
            {
                old = s[++i];
            }
            var path = s[++i];
            var (added, removed) = counts.TryGetValue(path, out var c) ? c : (null, null);
            files.Add(new GitCommitFile(path, old, code[..1], added, removed));
        }
        return files;
    }

    /// <summary>The fields of a --numstat line: added, removed, path (empty for a rename, whose paths follow).</summary>
    private enum NumstatField { Added, Removed, Path, Count }

    /// <summary>Each file's added and removed lines from <c>--numstat -z</c>; null counts for a binary file ("-").</summary>
    private static Dictionary<string, (int? Added, int? Removed)> LineCounts(string numstat)
    {
        var counts = new Dictionary<string, (int?, int?)>();
        var n = numstat.Split('\0');
        for (var i = 0; i < n.Length; i++)
        {
            var parts = n[i].Split('\t');
            if (parts.Length < (int)NumstatField.Count)
            {
                continue;
            }
            var path = parts[(int)NumstatField.Path];
            if (path.Length == 0 && i + 2 < n.Length)
            {
                i++; // a rename: the old path, then the new one
                path = n[++i];
            }
            counts[path] = (int.TryParse(parts[(int)NumstatField.Added], out var a) ? a : null, int.TryParse(parts[(int)NumstatField.Removed], out var r) ? r : null);
        }
        return counts;
    }

    // ---- git for-each-ref (the Branches tab) ----

    /// <summary>The branch format <see cref="Branches"/> reads.</summary>
    public static readonly string BranchFormat =
        $"--format=%(refname){Unit}%(refname:short){Unit}%(HEAD){Unit}%(objectname:short){Unit}%(upstream:short){Unit}%(upstream:track,nobracket){Unit}%(committerdate:iso-strict){Unit}%(contents:subject)";
    private const string CurrentMark = "*";
    private const string Gone = "gone";

    /// <summary>The fields of <see cref="BranchFormat"/>, in order.</summary>
    private enum BranchField { Ref, Name, Head, Short, Upstream, Track, Date, Subject, Count }

    public static IReadOnlyList<GitBranchInfo> Branches(string raw)
    {
        var list = new List<GitBranchInfo>();
        foreach (var line in raw.Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            var f = line.TrimEnd('\r').Split(Unit);
            if (f.Length < (int)BranchField.Count || f[(int)BranchField.Ref].EndsWith("/" + GitCommands.Head, StringComparison.Ordinal))
            {
                continue; // origin/HEAD only points at a branch
            }
            var track = f[(int)BranchField.Track];
            var (ahead, behind) = Track(track);
            var upstream = f[(int)BranchField.Upstream];
            list.Add(new GitBranchInfo(f[(int)BranchField.Ref], f[(int)BranchField.Name], f[(int)BranchField.Ref].StartsWith(RemotesPrefix, StringComparison.Ordinal),
                f[(int)BranchField.Head] == CurrentMark, f[(int)BranchField.Short], upstream.Length > 0 ? upstream : null, ahead, behind, track == Gone,
                f[(int)BranchField.Date], f[(int)BranchField.Subject]));
        }
        // The current branch first, then the other local ones, then remote ones (each newest first, as git sorted them).
        return list.OrderByDescending(b => b.Current).ThenBy(b => b.Remote).ToList();
    }

    /// <summary>"ahead 2, behind 1" from %(upstream:track,nobracket).</summary>
    private static (int Ahead, int Behind) Track(string track)
    {
        int ahead = 0, behind = 0;
        foreach (var part in track.Split(", ", StringSplitOptions.RemoveEmptyEntries))
        {
            var kv = part.Split(' ');
            if (kv.Length == 2 && int.TryParse(kv[1], out var n))
            {
                if (kv[0] == "ahead")
                {
                    ahead = n;
                }
                else if (kv[0] == "behind")
                {
                    behind = n;
                }
            }
        }
        return (ahead, behind);
    }
}
