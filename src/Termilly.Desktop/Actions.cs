using System.IO;
using System.Text;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>The words an action's target and arguments can hold in braces ({selection}), filled in when it runs.</summary>
internal static class ActionPlaceholders
{
    /// <summary>The text selected in the terminal.</summary>
    public const string Selection = "selection";
    /// <summary>The terminal's folder.</summary>
    public const string Folder = "folder";
    /// <summary>The web page of the folder's repository (from its origin remote).</summary>
    public const string Repo = "repo";
    /// <summary>The repository's current branch.</summary>
    public const string Branch = "branch";
    /// <summary>The first port a program in the terminal listens on.</summary>
    public const string Port = "port";
    /// <summary>The selection read as a file (path, path:line or path(line)), found from the terminal's folder.</summary>
    public const string File = "file";
    /// <summary>The line the selection names after the file; 1 when it names none.</summary>
    public const string Line = "line";
    /// <summary>The selection when it's a web address (an action using it is offered only for one).</summary>
    public const string Url = "url";
    /// <summary>An image file: a Smart Clip image (saved as a PNG), or a selected path to an image.</summary>
    public const string Image = "image";
    public static readonly IReadOnlyList<string> All = [Selection, Folder, Repo, Branch, Port, File, Line, Url, Image];
}

/// <summary>What the page knows when an action runs; the host works out the rest (the repository, the file).</summary>
internal sealed record ActionContext(string? Selection, string? Folder, int? Port, string? Image = null);

/// <summary>An action ready to start: a web page, or a program with its arguments and folder.</summary>
internal sealed record ActionLaunch(Uri? Url, string? Program = null, IReadOnlyList<string>? Arguments = null, string? Folder = null);

/// <summary>An action can't run here: what it needs is missing (no selection, not in a repository...).</summary>
internal sealed class ActionUnavailableException(string message) : Exception(message);

/// <summary>
/// Settings › Actions: web pages and programs started from Termilly, with placeholders filled in from the terminal.
/// A web page's values are encoded into the address; a program's arguments are split before they're filled in, so a
/// selection is always one argument, never more of the command line.
/// </summary>
internal static partial class Actions
{
    public const int MaxActions = 40;
    /// <summary>The most of a selection that's used: enough for an error message, not a whole log.</summary>
    public const int MaxSelection = 500;
    private const string LineOne = "1";
    /// <summary>VS Code’s command, which the default editor actions run.</summary>
    private const string VsCode = "code";
    private const string PathGroup = "path";
    private const string LineGroup = "line";
    /// <summary>The line in path(line).</summary>
    private const string ParenLineGroup = "pline";
    private const string HostGroup = "host";
    private const string GitSuffix = ".git";
    private const string GitScheme = "git";
    /// <summary>The files {image} takes.</summary>
    private static readonly string[] ImageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".tif", ".tiff"];
    private static readonly string[] RemoteSchemes = [Uri.UriSchemeHttps, Uri.UriSchemeHttp, Uri.UriSchemeSsh, GitScheme];
    private static readonly string[] WebPrefixes = [Uri.UriSchemeHttps + "://", Uri.UriSchemeHttp + "://", Brace(ActionPlaceholders.Repo)];

    /// <summary>The actions Termilly starts with, which the user can change or remove.</summary>
    public static IReadOnlyList<ActionSetting> Defaults { get; } =
    [
        new("search", "Search online", "https://www.google.com/search?q={selection}", Menu: true),
        new("browser", "Open browser", "https://www.google.com", Shortcut: "Ctrl+Alt+B"),
        new("editor", "Open folder in VS Code", VsCode, "{folder}"),
        new("editorFile", "Open file in VS Code", VsCode, "--goto {file}:{line}", Menu: true),
        new("repo", "Open repository on the web", "{repo}/tree/{branch}"),
        new("localhost", "Open localhost", "http://localhost:{port}"),
    ];

    public static string Brace(string placeholder) => "{" + placeholder + "}";

    /// <summary>A web page (it starts with http://, https:// or {repo}) rather than a program.</summary>
    public static bool IsWebPage(string target) => WebPrefixes.Any(p => target.TrimStart().StartsWith(p, StringComparison.OrdinalIgnoreCase));

    /// <summary>The placeholders an action uses, in its target and arguments.</summary>
    public static IReadOnlySet<string> PlaceholdersIn(ActionSetting action) =>
        Placeholder().Matches(action.Target + " " + action.Arguments).Select(m => m.Groups[1].Value)
            .Where(ActionPlaceholders.All.Contains).ToHashSet(StringComparer.Ordinal);

    /// <summary>
    /// The action with its placeholders filled in from <paramref name="values"/>; ActionUnavailableException when one
    /// it uses has no value.
    /// </summary>
    public static ActionLaunch Prepare(ActionSetting action, IReadOnlyDictionary<string, string> values)
    {
        foreach (var name in PlaceholdersIn(action))
        {
            if (!values.TryGetValue(name, out var v) || string.IsNullOrEmpty(v))
            {
                throw new ActionUnavailableException(Missing(name));
            }
        }
        if (IsWebPage(action.Target))
        {
            var address = Fill(action.Target.Trim(), name => name == ActionPlaceholders.Repo ? values[name] : EncodeForUrl(name, values[name]));
            return Uri.TryCreate(address, UriKind.Absolute, out var url) && (url.Scheme == Uri.UriSchemeHttps || url.Scheme == Uri.UriSchemeHttp)
                ? new ActionLaunch(url)
                : throw new ActionUnavailableException($"“{address}” isn’t a web address.");
        }
        var arguments = SplitArguments(action.Arguments ?? "").Select(a => Fill(a, name => values[name])).ToList();
        values.TryGetValue(ActionPlaceholders.Folder, out var folder);
        return new ActionLaunch(null, Environment.ExpandEnvironmentVariables(action.Target.Trim()), arguments, folder);
    }

    /// <summary>What the page sent and what the host found, by placeholder: only those with a value.</summary>
    public static Dictionary<string, string> Values(ActionContext context, string? repo, string? branch)
    {
        var values = new Dictionary<string, string>(StringComparer.Ordinal);
        void Add(string name, string? value)
        {
            if (!string.IsNullOrWhiteSpace(value))
            {
                values[name] = value;
            }
        }
        var selection = CleanSelection(context.Selection);
        Add(ActionPlaceholders.Selection, selection);
        Add(ActionPlaceholders.Folder, context.Folder);
        Add(ActionPlaceholders.Repo, repo);
        Add(ActionPlaceholders.Branch, branch);
        Add(ActionPlaceholders.Port, context.Port?.ToString(System.Globalization.CultureInfo.InvariantCulture));
        var file = FileOf(context.Selection, context.Folder);
        if (file is { } named)
        {
            Add(ActionPlaceholders.File, named.Path);
            Add(ActionPlaceholders.Line, named.Line ?? LineOne);
        }
        Add(ActionPlaceholders.Url, selection is not null && WebAddress().IsMatch(selection) ? selection : null);
        Add(ActionPlaceholders.Image, ImageFile(context.Image) ?? ImageFile(file?.Path));
        return values;
    }

    /// <summary>The path when it's an image file that's there, else null.</summary>
    private static string? ImageFile(string? path) =>
        !string.IsNullOrWhiteSpace(path) && ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase) && System.IO.File.Exists(path) ? path : null;

    [GeneratedRegex(@"^https?://\S+$", RegexOptions.IgnoreCase)]
    private static partial Regex WebAddress();

    /// <summary>The selection on one line, spaces squeezed, cut to a sensible length.</summary>
    public static string? CleanSelection(string? selection)
    {
        if (string.IsNullOrWhiteSpace(selection))
        {
            return null;
        }
        var text = Whitespace().Replace(selection.Trim(), " ");
        return text.Length > MaxSelection ? text[..MaxSelection] : text;
    }

    /// <summary>A file the selection names (a path, path:line[:column] or path(line[,column])) that exists, else null.</summary>
    public static (string Path, string? Line)? FileOf(string? selection, string? folder)
    {
        if (string.IsNullOrWhiteSpace(selection) || selection.Contains('\n'))
        {
            return null;
        }
        var m = FileAndLine().Match(selection.Trim().Trim('"', '\'', '`'));
        if (!m.Success)
        {
            return null;
        }
        var line = m.Groups[LineGroup].Success ? m.Groups[LineGroup].Value : m.Groups[ParenLineGroup].Success ? m.Groups[ParenLineGroup].Value : null;
        try
        {
            var path = m.Groups[PathGroup].Value;
            if (!Path.IsPathRooted(path))
            {
                if (string.IsNullOrEmpty(folder))
                {
                    return null;
                }
                path = Path.Combine(folder, path);
            }
            path = Path.GetFullPath(path);
            return System.IO.File.Exists(path) ? (path, line) : null;
        }
        catch (Exception e) when (e is ArgumentException or NotSupportedException or PathTooLongException or System.Security.SecurityException)
        {
            return null;
        }
    }

    /// <summary>
    /// A remote's address as its web page: git@host:owner/repo.git and ssh://git@host/owner/repo become
    /// https://host/owner/repo; an https address loses its user and .git. Null for anything else.
    /// </summary>
    public static string? WebPageOfRemote(string? remote)
    {
        if (string.IsNullOrWhiteSpace(remote))
        {
            return null;
        }
        var text = remote.Trim();
        if (ScpRemote().Match(text) is { Success: true } scp)
        {
            text = $"{Uri.UriSchemeHttps}://{scp.Groups[HostGroup].Value}/{scp.Groups[PathGroup].Value}";
        }
        if (!Uri.TryCreate(text, UriKind.Absolute, out var uri) || !RemoteSchemes.Contains(uri.Scheme))
        {
            return null;
        }
        var path = uri.AbsolutePath.TrimEnd('/');
        if (path.EndsWith(GitSuffix, StringComparison.OrdinalIgnoreCase))
        {
            path = path[..^GitSuffix.Length];
        }
        return path.Length > 1 ? $"{Uri.UriSchemeHttps}://{uri.Host}{path}" : null;
    }

    /// <summary>Arguments as a shell would split them: on spaces, with "double" or 'single' quotes keeping one together.</summary>
    public static List<string> SplitArguments(string arguments)
    {
        var list = new List<string>();
        var current = new StringBuilder();
        var inWord = false;
        char? quote = null;
        foreach (var c in arguments)
        {
            if (quote is { } q)
            {
                if (c == q)
                {
                    quote = null;
                }
                else
                {
                    current.Append(c);
                }
            }
            else if (c is '"' or '\'')
            {
                quote = c;
                inWord = true;
            }
            else if (char.IsWhiteSpace(c))
            {
                if (inWord)
                {
                    list.Add(current.ToString());
                    current.Clear();
                    inWord = false;
                }
            }
            else
            {
                current.Append(c);
                inWord = true;
            }
        }
        if (inWord)
        {
            list.Add(current.ToString());
        }
        return list;
    }

    /// <summary>The text with each known {placeholder} replaced; unknown braces stay as they are.</summary>
    private static string Fill(string text, Func<string, string> value) =>
        Placeholder().Replace(text, m => ActionPlaceholders.All.Contains(m.Groups[1].Value) ? value(m.Groups[1].Value) : m.Value);

    /// <summary>A value inside an address: encoded, except a branch's slashes, which a web page's path keeps.</summary>
    private static string EncodeForUrl(string name, string value) => name == ActionPlaceholders.Branch
        ? string.Join('/', value.Split('/').Select(Uri.EscapeDataString))
        : Uri.EscapeDataString(value);

    private static string Missing(string placeholder) => placeholder switch
    {
        ActionPlaceholders.Selection => "Select some text in the terminal first.",
        ActionPlaceholders.Folder => "This terminal hasn’t said which folder it’s in.",
        ActionPlaceholders.Repo => "This terminal’s folder isn’t in a Git repository with a remote on the web.",
        ActionPlaceholders.Branch => "This terminal’s folder isn’t on a Git branch.",
        ActionPlaceholders.Port => "No program in this terminal is listening on a port.",
        ActionPlaceholders.Url => "Select a web address first.",
        ActionPlaceholders.Image => "Pick an image first: one in Smart Clip, or a path to one.",
        _ => "Select a file’s path in the terminal first.",
    };

    [GeneratedRegex(@"\{(\w+)\}")]
    private static partial Regex Placeholder();

    [GeneratedRegex(@"\s+")]
    private static partial Regex Whitespace();

    /// <summary>path, path:line, path:line:column, path(line) or path(line,column).</summary>
    [GeneratedRegex(@"^(?<path>.+?)(?::(?<line>\d+)(?::\d+)?|\((?<pline>\d+)(?:,\s*\d+)?\))?:?$")]
    private static partial Regex FileAndLine();

    /// <summary>git@github.com:owner/repo.git, the scp-like form ssh remotes take.</summary>
    [GeneratedRegex(@"^(?:[\w.-]+@)?(?<host>[\w.-]+\.[a-z]{2,}):(?!//)(?<path>.+)$", RegexOptions.IgnoreCase)]
    private static partial Regex ScpRemote();
}
