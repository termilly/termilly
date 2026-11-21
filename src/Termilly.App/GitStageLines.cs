using System.Collections.Concurrent;
using System.Text;

namespace Termilly.Desktop;

internal static class StageLineActions
{
    public const string Stage = GitActions.Stage;
    public const string Unstage = GitActions.Unstage;
    public const string Discard = GitActions.Discard;
    public static readonly IReadOnlyList<string> All = [Stage, Unstage, Discard];
}

internal sealed record GitLinePreview(ChangeView View, long MaxBytes);

internal static class GitStageLines
{
    private const int MaxPreviews = 100;
    private const string Changed = "The file changed. Look again.";
    private static readonly ConcurrentDictionary<(string Runner, string Root, string Path, string Side), GitLinePreview> Previews = new();

    public static void Remember(string root, GitDiffTarget target, GitRunner git, ChangeView view, long maxBytes)
    {
        if (target.Side is not (DiffSides.Staged or DiffSides.Unstaged))
        {
            return;
        }
        var cache = Previews;
        if (cache.Count >= MaxPreviews)
        {
            cache.Clear();
        }
        cache[(git.Identity, root, target.Path, target.Side)] = new GitLinePreview(view, maxBytes);
    }

    public static GitActionDone Apply(string root, string? path, string? side, string? action,
        IReadOnlyList<int>? removed, IReadOnlyList<int>? added, GitRunner git)
    {
        var file = git.CheckPath(root, path);
        if (!StageLineActions.All.Contains(action) || (action == StageLineActions.Unstage ? side != DiffSides.Staged : side != DiffSides.Unstaged))
        {
            throw new ArgumentException("That action doesn't apply to this side.");
        }
        var cache = Previews;
        if (!cache.TryGetValue((git.Identity, root, file, side!), out var preview))
        {
            throw new InvalidOperationException(Changed);
        }
        var current = GitView.Diff(root, new GitDiffTarget(file, null, side!), preview.MaxBytes, git, remember: false);
        if (current.Before != preview.View.Before || current.After != preview.View.After)
        {
            throw new InvalidOperationException(Changed);
        }
        Check(root, file, current, git);
        var text = Pick(current.Before!, current.After!, removed ?? [], added ?? [], action == StageLineActions.Stage);
        string? kept = null;
        if (action == StageLineActions.Discard)
        {
            kept = GitSnapshots.Before(root, SnapshotReasons.BeforeDiscard, git);
            EnsureSame(root, file, side!, current, preview.MaxBytes, git);
            var original = git.ReadFile(root, file, preview.MaxBytes).Bytes ?? throw new InvalidOperationException(Changed);
            git.WriteFile(root, file, Blob.EncodeLike(original, text));
        }
        else
        {
            var entry = GitView.Text(git, root, GitCommands.ListFiles, GitCommands.Stage, GitCommands.Options.Paths, file).Split(' ', 2)[0];
            var original = git.Run(root, [GitCommands.CatFile, GitCommands.Blob, GitCommands.Object("", file)]);
            var hash = Encoding.UTF8.GetString(git.WithInput(root, ["hash-object", "-w", "--path=" + file, "--stdin"], bytes: Blob.EncodeLike(original, text))).Trim();
            EnsureSame(root, file, side!, current, preview.MaxBytes, git);
            git.Run(root, ["update-index", "--cacheinfo", entry, hash, file]);
        }
        cache.TryRemove((git.Identity, root, file, side!), out _);
        return new GitActionDone(true, kept);
    }

    private static void EnsureSame(string root, string file, string side, ChangeView expected, long maxBytes, GitRunner git)
    {
        var now = GitView.Diff(root, new GitDiffTarget(file, null, side), maxBytes, git, remember: false);
        if (now.Before != expected.Before || now.After != expected.After)
        {
            throw new InvalidOperationException(Changed);
        }
    }

    private static void Check(string root, string file, ChangeView view, GitRunner git)
    {
        var status = GitView.Status(root, git);
        var files = status.Staged.Concat(status.Unstaged).Concat(status.Untracked).Concat(status.Conflicted).Where(f => f.Path == file).ToList();
        if (view.Note is not null || view.Before is null || view.After is null || files.Any(f => f.OldPath is not null || f.Status != "M"))
        {
            throw new InvalidOperationException("Pick lines only in modified text files. Use a whole-file action for this file.");
        }
        var mode = GitView.Text(git, root, GitCommands.ListFiles, GitCommands.Stage, GitCommands.Options.Paths, file).Split(' ', 2)[0];
        if (mode is not ("100644" or "100755"))
        {
            throw new InvalidOperationException("Pick lines only in regular files.");
        }
        if (git is LocalGitRunner)
        {
            GitSnapshots.CheckFile(root, file);
        }
    }

    internal static string Pick(string before, string after, IReadOnlyList<int> removed, IReadOnlyList<int> added, bool forward)
    {
        var a = LineDiff.Lines(before);
        var b = LineDiff.Lines(after);
        var remove = removed.ToHashSet();
        var add = added.ToHashSet();
        var output = new List<string>();
        var source = forward ? before : after;
        var eol = source.Contains("\r\n", StringComparison.Ordinal) ? "\r\n" : "\n";
        int ai = 0, bi = 0;
        foreach (var run in LineDiff.Diff(before, after).Runs)
        {
            for (var i = 0; i < run.Count; i++)
            {
                if (run.Kind == DiffRun.Same)
                {
                    output.Add(forward ? Line(a, ai, before) : Line(b, bi, after));
                    ai++;
                    bi++;
                }
                else if (run.Kind == DiffRun.Removed)
                {
                    var selected = remove.Remove(ai + 1);
                    if (forward != selected)
                    {
                        output.Add(forward ? Line(a, ai, before) : ConvertEnding(Line(a, ai, before), eol));
                    }
                    ai++;
                }
                else
                {
                    var selected = add.Remove(bi + 1);
                    if (forward == selected)
                    {
                        output.Add(forward ? ConvertEnding(Line(b, bi, after), eol) : Line(b, bi, after));
                    }
                    bi++;
                }
            }
        }
        if (remove.Count > 0 || add.Count > 0 || removed.Count + added.Count == 0)
        {
            throw new ArgumentException("Those line numbers aren't changes in this diff.");
        }
        return string.Concat(output.Select((line, i) => i < output.Count - 1 && !line.EndsWith('\n') ? line + eol : line));
    }

    private static string Line(string[] lines, int index, string text) =>
        lines[index] + (index < lines.Length - 1 || text.EndsWith('\n') ? "\n" : "");

    private static string ConvertEnding(string line, string ending) => line.EndsWith('\n') ? line.TrimEnd('\r', '\n') + ending : line;
}
