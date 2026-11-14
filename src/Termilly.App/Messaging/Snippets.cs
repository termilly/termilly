namespace Termilly.Desktop.Messaging;

// A repository's snippets and tasks (RepoSnippets.cs, js/reposnippets.js): the snippets it keeps in
// .termilly/snippets.yml, the ones its .termilly.yml shares, and its VS Code tasks (.vscode/tasks.json).

/// <summary>A saved command as a repository keeps it: name and command, optionally a description and enter: false.</summary>
internal sealed record RepoSnippet(string Name, string Command, string? Description = null, bool? Enter = null);

/// <summary>
/// A VS Code task, as Termilly runs it: its command with args (quoted), variables filled in and each ${input:id} as a
/// {{id}} placeholder.
/// </summary>
/// <param name="Cwd">options.cwd, with its variables filled in; null for the repository's folder.</param>
/// <param name="Group">Its group's kind ("build", "test"), or null.</param>
/// <param name="Hidden">hide: true. It isn't listed, but a task that depends on it still runs it.</param>
/// <param name="DependsOn">The labels of the tasks that run before it, in order.</param>
internal sealed record RepoTask(string Label, string Command, string? Cwd, IReadOnlyDictionary<string, string>? Env,
    string? Group, bool IsDefault, bool Hidden, IReadOnlyList<string> DependsOn);

/// <summary>A task's ${input:id}: what to ask (promptString), or what to pick from (pickString).</summary>
internal sealed record TaskInput(string Id, string? Description, string? Default, IReadOnlyList<string>? Options, bool Password);

internal static partial class FromPage
{
    /// <summary>The snippets and tasks of the repository a folder is in.</summary>
    internal sealed record RepoSnippetsAsk(string? RequestId = null, string? Folder = null) : IPageMessage
    {
        public static string Type => "reposnippets:get";
    }

    /// <summary>A repository's snippets, written to its .termilly/snippets.yml (none left: the file goes).</summary>
    /// <param name="OnlyMe">Kept out of git: .termilly/ is in the repository's own .git/info/exclude.</param>
    internal sealed record RepoSnippetsSave(string? RequestId = null, string? Root = null, IReadOnlyList<RepoSnippet>? Snippets = null,
        bool OnlyMe = false) : IPageMessage
    {
        public static string Type => "reposnippets:save";
    }
}

internal static partial class ToPage
{
    /// <summary>The repository a folder is in (Root null when it's in none), with its snippets and tasks.</summary>
    /// <param name="Shared">The snippets: list of its .termilly.yml (the workspace layout a team shares).</param>
    internal sealed record RepoSnippetsFound(string? RequestId, string? Root, IReadOnlyList<RepoSnippet> Snippets,
        IReadOnlyList<RepoSnippet> Shared, IReadOnlyList<RepoTask> Tasks, IReadOnlyList<TaskInput> Inputs, bool OnlyMe,
        IReadOnlyList<string> Warnings) : IHostMessage
    {
        public static string Type => "reposnippets:found";
    }

    internal sealed record RepoSnippetsSaved(string? RequestId, string? Error) : IHostMessage
    {
        public static string Type => "reposnippets:saved";
    }

    /// <summary>A repository's snippet or task files changed (a git pull, an editor): the page reads them again.</summary>
    internal sealed record RepoSnippetsChanged(string Root) : IHostMessage
    {
        public static string Type => "reposnippets:changed";
    }
}
