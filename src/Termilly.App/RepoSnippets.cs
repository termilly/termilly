using System.IO;
using System.Text;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using YamlDotNet.Serialization;

namespace Termilly.Desktop;

/// <summary>
/// A repository's snippets and tasks: those it keeps in .termilly/snippets.yml (shared through git, or kept out of it
/// with .git/info/exclude), those its .termilly.yml shares, and its VS Code tasks. The repository is the folder with
/// .git (a folder, or a worktree's file) at or above the one asked about.
/// </summary>
internal static class RepoSnippets
{
    /// <summary>The repository's own folder for Termilly's files, hidden on Windows (dot folders are hidden elsewhere).</summary>
    public const string Folder = ".termilly";
    public const string FileName = "snippets.yml";
    /// <summary>A file bigger than this isn't read (a snippets or tasks file is a few KB).</summary>
    private const int MaxBytes = 512 * 1024;
    /// <summary>How far up from a folder its repository is looked for.</summary>
    private const int MaxDepth = 64;
    private const string GitName = ".git";
    /// <summary>A worktree's .git is a file: "gitdir: path"; its exclude file is in the main repository's (commondir).</summary>
    private const string GitDirPrefix = "gitdir:";
    private const string CommonDirFile = "commondir";
    /// <summary>The line in .git/info/exclude that keeps the folder out of git.</summary>
    private const string ExcludeLine = "/" + Folder + "/";
    private const string Header = "# Snippets for this repository, shown by Termilly's snippets button. {{name}} asks for a value when it runs.\n";

    public static string SnippetsPath(string root) => Path.Combine(root, Folder, FileName);
    public static string TasksPath(string root) => Path.Combine(root, VsCodeTasks.Folder, VsCodeTasks.FileName);

    /// <summary>The repository a folder is in: the nearest folder at or above it with .git; null when there's none.</summary>
    public static string? RootOf(string folder)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
        {
            return null;
        }
        var dir = new DirectoryInfo(Path.GetFullPath(folder));
        for (var depth = 0; dir is not null && depth < MaxDepth; depth++, dir = dir.Parent)
        {
            var git = Path.Combine(dir.FullName, GitName);
            if (Directory.Exists(git) || File.Exists(git))
            {
                return dir.FullName;
            }
        }
        return null;
    }

    /// <summary>The snippets and tasks of the repository <paramref name="folder"/> is in.</summary>
    public static ToPage.RepoSnippetsFound Read(string? requestId, string folder)
    {
        var root = RootOf(folder);
        if (root is null)
        {
            return new(requestId, null, [], [], [], [], OnlyMe: false, []);
        }
        var warnings = new List<string>();
        var snippets = Text(SnippetsPath(root), warnings) is { } own ? WorkspaceLayout.SnippetsOf(own, warnings) : [];
        // The layout file in the repository's folder, and in the folder asked about when that's further down.
        var layouts = new[] { root, Path.GetFullPath(folder) }.Distinct(ChangePaths.Comparer)
            .Select(dir => Text(Path.Combine(dir, WorkspaceLayout.FileName), warnings)).OfType<string>();
        var shared = layouts.SelectMany(yaml => WorkspaceLayout.SnippetsOf(yaml, warnings)).ToList();
        var (tasks, inputs) = Text(TasksPath(root), warnings) is { } json ? VsCodeTasks.Parse(json, root, warnings) : ([], []);
        return new(requestId, root, snippets, shared, tasks, inputs, IsOnlyMe(root), warnings);
    }

    /// <summary>
    /// Writes a repository's snippets to .termilly/snippets.yml (the folder hidden on Windows), and keeps the folder
    /// in or out of git; with no snippets left the file goes, and the folder too when nothing else is in it.
    /// </summary>
    public static void Write(string root, IReadOnlyList<RepoSnippet> snippets, bool onlyMe)
    {
        if (RootOf(root) is not { } found || !ChangePaths.Comparer.Equals(found, Path.TrimEndingDirectorySeparator(Path.GetFullPath(root))))
        {
            throw new IOException("That folder isn't a git repository.");
        }
        var path = SnippetsPath(root);
        var folder = Path.GetDirectoryName(path)!;
        if (snippets.Count == 0)
        {
            File.Delete(path);
            if (Directory.Exists(folder) && !Directory.EnumerateFileSystemEntries(folder).Any())
            {
                Directory.Delete(folder);
            }
        }
        else
        {
            AppPaths.WriteAtomically(path, ToYaml(snippets));
            Hide(folder);
        }
        SetOnlyMe(root, onlyMe);
    }

    /// <summary>The file's text: name and command first, a description, and enter only when it's false.</summary>
    public static string ToYaml(IReadOnlyList<RepoSnippet> snippets)
    {
        var list = snippets.Select(s =>
        {
            var entry = new Dictionary<string, object> { [WorkspaceLayout.Keys.Name] = s.Name, [WorkspaceLayout.Keys.Command] = s.Command };
            if (!string.IsNullOrWhiteSpace(s.Description))
            {
                entry[WorkspaceLayout.Keys.Description] = s.Description;
            }
            if (s.Enter == false)
            {
                entry[WorkspaceLayout.Keys.Enter] = false;
            }
            return entry;
        }).ToList();
        return Header + new SerializerBuilder().Build().Serialize(new Dictionary<string, object> { [WorkspaceLayout.Keys.Snippets] = list });
    }

    /// <summary>Whether the repository keeps .termilly/ out of git (its line in .git/info/exclude).</summary>
    public static bool IsOnlyMe(string root) =>
        ExcludeFile(root) is { } file && File.Exists(file) && ReadLines(file).Any(l => l.Trim() == ExcludeLine);

    private static void SetOnlyMe(string root, bool onlyMe)
    {
        if (IsOnlyMe(root) == onlyMe || ExcludeFile(root) is not { } file)
        {
            return;
        }
        // Without the file's last line break, which would come back as an empty line each time.
        var text = File.Exists(file) ? File.ReadAllText(file).TrimEnd('\r', '\n') : "";
        var lines = text.Length == 0 ? [] : text.Split('\n').Select(l => l.TrimEnd('\r')).ToList();
        if (onlyMe)
        {
            lines.Add(ExcludeLine);
        }
        else
        {
            lines.RemoveAll(l => l.Trim() == ExcludeLine);
        }
        AppPaths.WriteAtomically(file, string.Join('\n', lines) + "\n");
    }

    /// <summary>The repository's info/exclude: in .git, or for a worktree in the main repository's git folder.</summary>
    private static string? ExcludeFile(string root)
    {
        var git = Path.Combine(root, GitName);
        var dir = Directory.Exists(git) ? git : File.Exists(git) ? WorktreeGitDir(root, git) : null;
        return dir is null ? null : Path.Combine(dir, "info", "exclude");
    }

    private static string? WorktreeGitDir(string root, string gitFile)
    {
        var line = ReadLines(gitFile).FirstOrDefault(l => l.StartsWith(GitDirPrefix, StringComparison.Ordinal));
        if (line is null)
        {
            return null;
        }
        var dir = Path.GetFullPath(Path.Combine(root, line[GitDirPrefix.Length..].Trim()));
        var common = Path.Combine(dir, CommonDirFile);
        return File.Exists(common) ? Path.GetFullPath(Path.Combine(dir, File.ReadAllText(common).Trim())) : dir;
    }

    private static IEnumerable<string> ReadLines(string file) => File.ReadAllText(file).Split('\n').Select(l => l.TrimEnd('\r'));

    /// <summary>Windows shows dot folders; this one is hidden, as it is in Finder and file managers.</summary>
    private static void Hide(string folder)
    {
        if (OperatingSystem.IsWindows())
        {
            var info = new DirectoryInfo(folder);
            info.Attributes |= FileAttributes.Hidden;
        }
    }

    /// <summary>A file's text; null when it isn't there or is too big (said in the warnings), or can't be read.</summary>
    private static string? Text(string path, List<string> warnings)
    {
        try
        {
            var info = new FileInfo(path);
            if (!info.Exists)
            {
                return null;
            }
            if (info.Length > MaxBytes)
            {
                warnings.Add($"{info.Name} is too big to read.");
                return null;
            }
            return File.ReadAllText(path, Encoding.UTF8);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            warnings.Add(e.Message);
            return null;
        }
    }
}
