using System.IO;
using System.IO.Enumeration;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// The compact view's @ picker (js/compactinput.js): the files under the agent's folder whose path holds what was
/// typed after the @, best first (the name starts with it, then the name holds it, then the path; shorter first).
/// Folders that are never what's meant (.git, node_modules, build output) are skipped, and the walk stops after
/// <see cref="MostVisited"/> entries, so a home folder can't keep it busy.
/// </summary>
internal sealed class CompactFiles(PageChannel page) : IMessageHandler
{
    /// <summary>At most this many are offered.</summary>
    public const int MostFound = 40;
    /// <summary>The walk stops after this many files and folders.</summary>
    private const int MostVisited = 50_000;

    /// <summary>Folders the picker never looks in.</summary>
    private static readonly HashSet<string> Skipped = new(StringComparer.OrdinalIgnoreCase)
    {
        ".git", ".hg", ".svn", "node_modules", "bin", "obj", "dist", "build", "out", "target", ".venv", "venv",
        "__pycache__", ".next", ".cache", ".idea", ".vs", "packages",
    };

    public void Register(MessageRouter router) => router.On<FromPage.CompactFiles>(m => Task.Run(() =>
        page.Post(new ToPage.CompactFilesFound(m.RequestId, Find(m.Dir ?? "", m.Text ?? "")))));

    /// <summary>The files under a folder whose relative path holds the text, best first, with / between folders.</summary>
    public static IReadOnlyList<string> Find(string dir, string text)
    {
        if (!Directory.Exists(dir))
        {
            return [];
        }
        var visited = 0;
        var found = new List<string>();
        var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = true, AttributesToSkip = FileAttributes.ReparsePoint };
        var files = new FileSystemEnumerable<string>(dir, (ref FileSystemEntry e) => e.ToFullPath(), options)
        {
            ShouldRecursePredicate = (ref FileSystemEntry e) => !Skipped.Contains(e.FileName.ToString()) && visited < MostVisited,
            ShouldIncludePredicate = (ref FileSystemEntry e) => ++visited <= MostVisited && !e.IsDirectory,
        };
        try
        {
            foreach (var file in files)
            {
                var relative = Path.GetRelativePath(dir, file).Replace('\\', '/');
                if (relative.Contains(text, StringComparison.OrdinalIgnoreCase))
                {
                    found.Add(relative);
                }
            }
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // the folder went away mid-walk: what was found stands
        }
        return found.OrderBy(path => Rank(path, text)).ThenBy(path => path.Length).ThenBy(path => path, StringComparer.Ordinal)
            .Take(MostFound).ToList();
    }

    /// <summary>0 when the file's name starts with the text, 1 when its name holds it, 2 when only its folders do.</summary>
    private static int Rank(string path, string text)
    {
        var name = Path.GetFileName(path);
        return name.StartsWith(text, StringComparison.OrdinalIgnoreCase) ? 0
            : name.Contains(text, StringComparison.OrdinalIgnoreCase) ? 1
            : 2;
    }
}
