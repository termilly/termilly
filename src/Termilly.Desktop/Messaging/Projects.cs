using System.Text.Json;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Messaging;

// Workspace layouts (.termilly.yml), the change preview, git (the sidebar's chips and the Git window) and agent
// worktrees.

internal static partial class FromPage
{
    internal sealed record LayoutExport(string? Name = null, JsonElement Layout = default) : IPageMessage
    {
        public static string Type => "layout:export";
    }

    internal sealed record LayoutImport : IPageMessage
    {
        public static string Type => "layout:import";
    }

    /// <summary>Is there a .termilly.yml in the folder a workspace is about to open in?</summary>
    internal sealed record LayoutProbe(string? RequestId = null, string? Dir = null) : IPageMessage
    {
        public static string Type => "layout:probe";
    }

    internal sealed record ChangesList(string Id = "") : IPageMessage
    {
        public static string Type => "changes:list";
    }

    /// <summary>Forgets a terminal's changed file (<see cref="Path"/>), or all of them.</summary>
    internal sealed record ChangesClear(string Id = "", string? Path = null) : IPageMessage
    {
        public static string Type => "changes:clear";
    }

    /// <param name="Compare">What to compare with ("session", "last"); Settings' choice when null.</param>
    internal sealed record ChangesGet(string Id = "", string? RequestId = null, string? Path = null, string? Compare = null) : IPageMessage
    {
        public static string Type => "changes:get";
    }

    /// <summary>Which file a path Ctrl+clicked in a terminal means.</summary>
    /// <param name="Remote">The terminal's files aren't on this machine (SSH, WSL, containers).</param>
    internal sealed record ChangesResolve(string Id = "", string? RequestId = null, string? Text = null, bool Remote = false,
        string? Cwd = null, string? WsCwd = null) : IPageMessage
    {
        public static string Type => "changes:resolve";
    }

    /// <summary>Project status for the sidebar (js/gitstatus.js): the repositories these folders are in.</summary>
    internal sealed record GitFolders(IReadOnlyList<string>? Folders = null, bool Force = false) : IPageMessage
    {
        public static string Type => "git:status";
    }

    /// <param name="Remote">The SSH terminal whose server the repository is on; null for this PC.</param>
    internal sealed record GitViewStatus(string? RequestId = null, string? Remote = null, string? Folder = null) : IPageMessage
    {
        public static string Type => "gitview:status";
    }

    /// <param name="Side">"staged", "unstaged", "untracked" or "commit" (with <paramref name="Hash"/>).</param>
    internal sealed record GitViewDiff(string? RequestId = null, string? Remote = null, string? Root = null, string? Path = null,
        string? OldPath = null, string? Side = null, string? Hash = null) : IPageMessage
    {
        public static string Type => "gitview:diff";
    }

    internal sealed record GitViewLog(string? RequestId = null, string? Remote = null, string? Root = null, int Skip = 0,
        int Limit = GitViewLog.DefaultLimit, string? Ref = null) : IPageMessage
    {
        public const int DefaultLimit = 100;

        public static string Type => "gitview:log";
    }

    internal sealed record GitViewCommit(string? RequestId = null, string? Remote = null, string? Root = null, string? Hash = null) : IPageMessage
    {
        public static string Type => "gitview:commit";
    }

    /// <summary>The Git window's search (GitSearch.Search): changed files, commits, branches and tags.</summary>
    internal sealed record GitViewSearch(string? RequestId = null, string? Remote = null, string? Root = null, string? Query = null) : IPageMessage
    {
        public static string Type => "gitview:search";
    }

    /// <summary>The search's code in commits, one batch of history at a time (GitSearch.SearchCode).</summary>
    internal sealed record GitViewSearchCode(string? RequestId = null, string? Remote = null, string? Root = null, string? Query = null,
        int Batch = 0) : IPageMessage
    {
        public static string Type => "gitview:searchcode";
    }

    internal sealed record GitViewBranches(string? RequestId = null, string? Remote = null, string? Root = null) : IPageMessage
    {
        public static string Type => "gitview:branches";
    }

    /// <summary>An action from the Git window's menus (GitView.Act).</summary>
    internal sealed record GitViewAct(string? RequestId = null, string? Remote = null, string? Root = null, string? Action = null,
        string? Path = null, string? Ref = null, bool HasCommits = true) : IPageMessage
    {
        public static string Type => "gitview:act";
    }

    internal sealed record WorktreeCreate(string? RequestId = null, string? Folder = null, string? Branch = null) : IPageMessage
    {
        public static string Type => "worktree:create";
    }

    internal sealed record WorktreeStatus(string? RequestId = null, string? Repo = null, string? Path = null, string? Branch = null) : IPageMessage
    {
        public static string Type => "worktree:status";
    }

    internal sealed record WorktreeRemove(string? RequestId = null, string? Repo = null, string? Path = null, string? Branch = null,
        bool DeleteBranch = false, bool Force = false) : IPageMessage
    {
        public static string Type => "worktree:remove";
    }
}

internal static partial class ToPage
{
    /// <summary>An imported layout file ("Import a workspace layout").</summary>
    internal sealed record ImportedLayout(string? RequestId, JsonObject? Layout, IReadOnlyList<string> Warnings, string Path) : IHostMessage
    {
        public static string Type => "layout";
    }

    /// <summary>The .termilly.yml found in a folder; <see cref="Path"/> is null and the layout too when there's none.</summary>
    internal sealed record LayoutFound(string? RequestId, JsonObject? Layout, IReadOnlyList<string> Warnings, string Path) : IHostMessage
    {
        public static string Type => "layout:found";
    }

    internal sealed record NoLayoutFound(string? RequestId) : IHostMessage
    {
        public static string Type => "layout:found";

        public JsonObject? Layout { get; }
    }

    internal sealed record LayoutExported(string Path) : IHostMessage
    {
        public static string Type => "layout:exported";
    }

    internal sealed record LayoutError(string Message) : IHostMessage
    {
        public static string Type => "layout:error";
    }

    internal sealed record ChangesList(string Id, object Files) : IHostMessage
    {
        public static string Type => "changes:list";
    }

    internal sealed record ChangeContent(string? RequestId, ChangeView? View, string? Error) : IHostMessage
    {
        public static string Type => "changes:content";
    }

    internal sealed record ChangeResolved(string? RequestId, string? Path, int? Line, string? Error) : IHostMessage
    {
        public static string Type => "changes:resolved";
    }

    internal sealed record GitStates(IReadOnlyList<GitFolderState> States) : IHostMessage
    {
        public static string Type => "git:status";
    }

    /// <summary>A Git window request's answer: its data, or git's error.</summary>
    internal sealed record GitViewResult(string? RequestId, object? Data, string? Error) : IHostMessage
    {
        public static string Type => "gitview:result";
    }

    internal sealed record WorktreeCreated(string? RequestId, string Repo, string Path, string Branch, object Copied) : IHostMessage
    {
        public static string Type => "worktree:reply";

        public bool Ok { get; } = true;
    }

    internal sealed record WorktreeState(string? RequestId, object Status) : IHostMessage
    {
        public static string Type => "worktree:reply";

        public bool Ok { get; } = true;
    }

    internal sealed record WorktreeDone(string? RequestId) : IHostMessage
    {
        public static string Type => "worktree:reply";

        public bool Ok { get; } = true;
    }

    internal sealed record WorktreeFailed(string? RequestId, string Message) : IHostMessage
    {
        public static string Type => "worktree:reply";

        public bool Ok { get; }
    }
}
