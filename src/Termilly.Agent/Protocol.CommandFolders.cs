namespace Termilly.Agent;

/// <summary>The folders a shell command may change, for the change preview (see Message).</summary>
internal static partial class Protocol
{
    /// <summary>The folder ChangeDirectory captures.</summary>
    private const string DirGroup = "dir";
    /// <summary>A path ending in these is a folder, though it has a dot.</summary>
    private static readonly string[] DotFolders = [".", ".."];

    // Claude's shell tools (ClaudeTools.ShellTools): a command can create or change files too (Copy-Item, Set-Content,
    // sed -i), so while one runs the change preview watches the folders it may touch: the folder Claude works in, and
    // the folders of the paths the command names (see CommandFolders). The command itself is never passed.

    /// <summary>The most folders passed for one command.</summary>
    public const int MaxFolders = HookMessage.MaxFolders;

    /// <summary>
    /// The folders of the paths a command names, worked out here so that only they leave the hook: for
    /// "Set-Content 'd:\temp\b.ps1'" that's "d:\temp". A path that looks like a file (it has an extension) gives its
    /// folder; one that doesn't is taken as a folder. Relative paths are taken from where the command first changes
    /// to (cd /d/temp && sed -i ... test.ps1 gives "/d/temp"), else stay relative (the app reads them from Claude's
    /// folder); a bare file name gives that folder, or ".".
    /// </summary>
    public static List<string> CommandFolders(string? command)
    {
        var folders = new List<string>();
        if (string.IsNullOrEmpty(command))
        {
            return folders;
        }
        var cd = ChangeDirectory().Match(command) is { Success: true } go ? go.Groups[DirGroup].Value : null;
        foreach (System.Text.RegularExpressions.Match m in CommandPath().Matches(command))
        {
            var path = m.Value.TrimEnd('.', ',', ';', ':');
            var cut = Math.Max(path.LastIndexOf('\\'), path.LastIndexOf('/'));
            var last = path[(cut + 1)..];
            var folder = !last.Contains('.') || DotFolders.Contains(last) ? path
                : cut > 0 ? path[..cut]
                : cut == 0 ? path[..1]
                : ".";
            if (cd is not null && !IsRooted(folder))
            {
                folder = folder == "." ? cd : cd.TrimEnd('/', '\\') + "/" + folder;
            }
            if (folder.Length is > 0 and <= MaxPath && !folders.Contains(folder, StringComparer.OrdinalIgnoreCase))
            {
                folders.Add(folder);
            }
            if (folders.Count == MaxFolders)
            {
                break;
            }
        }
        return folders;
    }

    private static bool IsRooted(string path) =>
        path.Length >= 2 && path[1] == ':' || path.StartsWith('/') || path.StartsWith('\\') || path.StartsWith('~');

    // Windows paths (C:\a\b.ps1, C:/a), Git Bash drives (/c/a/b.ps1, /d/temp), Linux paths (/tmp/proj/a.ts,
    // /home/me/proj; at least two characters after the slash, so cmd's /c isn't a drive), home (~/a), relative paths
    // with a folder (src/a.ts, .\a.ps1) and bare file names with an extension (a.ps1). Quotes, separators and shell
    // variables ($i) end a path.
    [System.Text.RegularExpressions.GeneratedRegex(@"(?<![\w$-])(?:[A-Za-z]:[\\/]|/[a-zA-Z]/|~[\\/]|\.{1,2}[\\/]|/(?=[\w.@-]{2}))?(?:[\w.@-]+[\\/])*[\w@-][\w.@-]*\.[A-Za-z0-9]{1,10}(?![\w(])|(?<![\w$-])(?:[A-Za-z]:[\\/]|/[a-zA-Z]/|~[\\/]|/(?=[\w.@-]{2}))(?:[\w.@-]+[\\/])*[\w.@-]*")]
    private static partial System.Text.RegularExpressions.Regex CommandPath();

    // Where a command first moves to: cd, pushd, Set-Location, Push-Location, sl (with -Path or -LiteralPath).
    [System.Text.RegularExpressions.GeneratedRegex(@"(?:^|[;&|(]\s*)(?:cd|pushd|Set-Location|Push-Location|sl)\s+(?:-(?:Literal)?Path\s+)?(['""]?)(?<dir>[^'""\s;&|)]+)\1", System.Text.RegularExpressions.RegexOptions.IgnoreCase)]
    private static partial System.Text.RegularExpressions.Regex ChangeDirectory();
}
