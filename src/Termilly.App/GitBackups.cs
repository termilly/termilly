using System.Globalization;

namespace Termilly.Desktop;

internal static class BackupEvents
{
    public const string Prune = "prune";
    public const string UndoCommit = "undoCommit";
    public static readonly IReadOnlyList<string> All = [Prune, UndoCommit];
}

internal sealed record Backup(string Id, string At, string Event, string Branch, string Hash, string Subject);
internal sealed record BackupRestoreResult(string Branch);

internal static class GitBackups
{
    private const int BackupParts = 3;
    private const string Prefix = "refs/termilly/backups/";
    private const string RestoredSuffix = "-restored";
    private static readonly Lock Gate = new();

    public static string Take(string root, string branch, string reason, GitRunner git)
    {
        GitSnapshots.RequireLocal(git);
        if (!BackupEvents.All.Contains(reason) || !GitView.Branches(root, git).Any(b => !b.Remote && b.Name == branch))
        {
            throw new ArgumentException("That branch isn't in the repository.");
        }
        lock (Gate)
        {
            var previous = List(root, git);
            var at = DateTimeOffset.UtcNow;
            var id = Prefix + at.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) + "/" + reason + "/" + branch;
            while (previous.Any(b => b.Id == id))
            {
                at = at.AddMilliseconds(1);
                id = Prefix + at.ToUnixTimeMilliseconds().ToString(CultureInfo.InvariantCulture) + "/" + reason + "/" + branch;
            }
            git.Run(root, [GitCommands.UpdateRef, id, GitCommands.Refs.HeadsPrefix + branch]);
            foreach (var item in previous.Where(b => DateTimeOffset.Parse(b.At, CultureInfo.InvariantCulture) < at.AddDays(-GitSnapshots.RetentionDays)))
            {
                git.Run(root, [GitCommands.UpdateRef, GitCommands.DeleteRef, item.Id]);
            }
            return id;
        }
    }

    public static IReadOnlyList<Backup> List(string root, GitRunner git)
    {
        GitSnapshots.RequireLocal(git);
        return GitView.Text(git, root, GitCommands.ForEachRef, "--format=%(refname)%00%(objectname)%00%(subject)", Prefix)
            .Split('\n', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries)
            .Select(Parse).OrderByDescending(b => b.At, StringComparer.Ordinal).ToList();
    }

    private static Backup Parse(string line)
    {
        var fields = line.Split('\0');
        var parts = fields[0][Prefix.Length..].Split('/', BackupParts);
        var at = DateTimeOffset.FromUnixTimeMilliseconds(long.Parse(parts[0], CultureInfo.InvariantCulture));
        return new Backup(fields[0], at.ToString("O", CultureInfo.InvariantCulture), parts[1], parts[2], fields[1], fields[2]);
    }

    public static BackupRestoreResult Restore(string root, string? id, GitRunner git)
    {
        lock (Gate)
        {
            var item = List(root, git).FirstOrDefault(b => b.Id == id) ?? throw new ArgumentException("That backup isn't in the repository.");
            var names = GitView.Branches(root, git).Where(b => !b.Remote).Select(b => b.Name).ToHashSet(StringComparer.Ordinal);
            var branch = item.Branch;
            var number = 1;
            while (names.Contains(branch))
            {
                branch = item.Branch + RestoredSuffix + (number == 1 ? "" : "-" + number.ToString(CultureInfo.InvariantCulture));
                number++;
            }
            git.Run(root, [GitCommands.Branch, branch, item.Hash]);
            return new BackupRestoreResult(branch);
        }
    }
}
