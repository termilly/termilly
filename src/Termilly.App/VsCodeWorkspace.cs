using System.IO;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// The VS Code workspace files in a repository's folder (*.code-workspace, JSON with comments) and their tasks. Each is
/// a workspace of its own, as VS Code opens one at a time: ${workspaceFolder} is its first folder (and where its tasks
/// run), ${workspaceFolder:name} each named one, and a folder's path is relative to the file.
/// </summary>
internal static class VsCodeWorkspace
{
    public const string Extension = ".code-workspace";
    /// <summary>How many workspace files are read; a repository has one or two.</summary>
    public const int MaxFiles = 8;

    private static class Keys
    {
        public const string Folders = "folders";
        public const string FolderPath = "path";
        public const string FolderUri = "uri";
        public const string Name = "name";
        public const string Tasks = "tasks";
    }

    /// <summary>Whether a file name is a workspace file's (its extension in any case, as VS Code takes it).</summary>
    public static bool IsWorkspaceFile(string name) =>
        name.Length > Extension.Length && name.EndsWith(Extension, StringComparison.OrdinalIgnoreCase);

    /// <summary>The workspace files in a folder (not below it), in name order; past <see cref="MaxFiles"/> a warning.</summary>
    public static IReadOnlyList<string> FilesIn(string root, List<string> warnings)
    {
        List<string> files;
        try
        {
            files = [.. Directory.EnumerateFiles(root).Where(f => IsWorkspaceFile(Path.GetFileName(f))).Order(StringComparer.Ordinal)];
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            warnings.Add(e.Message);
            return [];
        }
        if (files.Count > MaxFiles)
        {
            warnings.Add($"Only the first {MaxFiles} of the {files.Count} {Extension} files are read.");
        }
        return files.Take(MaxFiles).ToList();
    }

    /// <summary>A workspace file's tasks and inputs; none when it has no tasks.</summary>
    /// <param name="path">The file's full path, in the repository's folder.</param>
    public static (IReadOnlyList<RepoTask> Tasks, IReadOnlyList<TaskInput> Inputs) Parse(string json, string path, List<string> warnings)
    {
        var name = Path.GetFileName(path);
        if (VsCodeTasks.ParseJson(json, name, warnings) is not { } top || top[Keys.Tasks] is not JsonObject tasks)
        {
            return ([], []);
        }
        var folders = Folders(top, Path.GetDirectoryName(path)!);
        var first = folders.Count > 0 ? folders[0].Path : null;
        // A name given twice: the first is the one VS Code finds.
        var named = folders.GroupBy(f => f.Name, StringComparer.Ordinal).ToDictionary(g => g.Key, g => g.First().Path, StringComparer.Ordinal);
        return VsCodeTasks.Parse(tasks, new TaskSource(name, first, named, first));
    }

    /// <summary>
    /// The workspace's folders, each with its name (its own as written, or its folder's): a path relative to the file's
    /// folder (or whole), or a file: uri. Other uris (a remote's) have no folder here and are left out, and so is a
    /// folder listed again, as VS Code does.
    /// </summary>
    private static List<(string Name, string Path)> Folders(JsonObject top, string dir)
    {
        var list = new List<(string Name, string Path)>();
        foreach (var folder in (top[Keys.Folders] as JsonArray ?? []).OfType<JsonObject>())
        {
            if (PathOf(folder, dir) is not { } path || list.Any(f => ChangePaths.Comparer.Equals(f.Path, path)))
            {
                continue;
            }
            var name = folder[Keys.Name] is JsonValue n && n.ToString() is { Length: > 0 } given ? given : Path.GetFileName(path);
            list.Add((name.Length > 0 ? name : path, path));
        }
        return list;
    }

    private static string? PathOf(JsonObject folder, string dir)
    {
        try
        {
            var path = folder[Keys.FolderPath] is JsonValue p ? Path.GetFullPath(Path.Combine(dir, p.ToString()))
                : folder[Keys.FolderUri] is JsonValue u ? FileUriPath(u.ToString())
                : null;
            return path is null ? null : Path.TrimEndingDirectorySeparator(path);
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException)
        {
            return null; // a path this system can't have: no folder here
        }
    }

    /// <summary>
    /// A file: uri's path; null for another scheme. VS Code writes a Windows drive as file:///c%3A/dir, which reads as
    /// "/c:/dir": the drive's slash goes.
    /// </summary>
    private static string? FileUriPath(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || !uri.IsFile)
        {
            return null;
        }
        var path = uri.LocalPath;
        return OperatingSystem.IsWindows() && path.Length > 2 && path[0] is '/' or '\\' && char.IsAsciiLetter(path[1]) && path[2] == ':'
            ? Path.GetFullPath(path[1..])
            : path;
    }
}
