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
internal sealed class CompactFiles(PageChannel page) : IMessageHandler, IDisposable
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

    /// <summary>The walk running now: a newer question stops it (the user typed on).</summary>
    private CancellationTokenSource? _walking;

    public void Register(MessageRouter router) => router.On<FromPage.CompactFiles>(m =>
    {
        var cancel = new CancellationTokenSource();
        Interlocked.Exchange(ref _walking, cancel)?.Cancel();
        // Every question gets its answer (a stopped one, what it found so far), so none waits on the page for good;
        // the page uses only the answer to its latest.
        _ = Task.Run(() => page.Post(new ToPage.CompactFilesFound(m.RequestId, Find(m.Dir ?? "", m.Text ?? "", cancel.Token))));
    });

    public void Dispose() => Interlocked.Exchange(ref _walking, null)?.Cancel();

    /// <summary>
    /// The files under a folder whose relative path holds the text, best first, with / between folders; what was found
    /// so far once <see cref="MostVisited"/> entries were seen or it was stopped.
    /// </summary>
    public static IReadOnlyList<string> Find(string dir, string text, CancellationToken stop = default)
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
            // Past the limit, or stopped, every entry comes through, so the loop below gets to end the walk.
            ShouldIncludePredicate = (ref FileSystemEntry e) => ++visited > MostVisited || stop.IsCancellationRequested || !e.IsDirectory,
        };
        try
        {
            foreach (var file in files)
            {
                if (visited > MostVisited || stop.IsCancellationRequested)
                {
                    break;
                }
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
