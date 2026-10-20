using System.IO;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>The change preview (Changes.cs, js/preview.js): the files Claude changed in each terminal, each one's change, and which file a clicked path means.</summary>
internal sealed class ChangesHandler : IMessageHandler
{
    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly ChangeStore _changes;
    private readonly ChangePreview _preview;

    public ChangesHandler(PageChannel page, ISettingsStore settings, ChangeStore changes, ChangePreview preview, TerminalSessions terminals)
    {
        (_page, _settings, _changes, _preview) = (page, settings, changes, preview);
        // Line counts take a diff: worked out off the hook's thread, so the agent never waits on them.
        changes.Changed += id => Task.Run(() => PostList(id));
        // A restarted terminal starts a new list; a closed one's goes.
        terminals.Restarting += changes.Forget;
        terminals.Closed += changes.Forget;
        settings.Saved += change =>
        {
            if (change.Previous.Changes.Enabled && !change.Current.Changes.Enabled)
            {
                changes.Clear();
            }
        };
    }

    public void Register(MessageRouter router)
    {
        router.On<FromPage.ChangesList>(m => Task.Run(() => PostList(m.Id)));
        router.On<FromPage.ChangesClear>(m => _changes.Clear(m.Id, m.Path));
        router.On<FromPage.ChangesGet>(m => Task.Run(() => Get(m.Id, m.RequestId, m.Path, m.Compare)));
        router.On<FromPage.ChangesResolve>(m => Task.Run(() => Resolve(m)));
    }

    private void PostList(string id) => _page.Post(new ToPage.ChangesList(id, _preview.List(id)));

    /// <summary>A file's change for the preview: both texts and the diff (disk and git work, so off the UI thread).</summary>
    private void Get(string id, string? requestId, string? path, string? compare)
    {
        ChangeView? view = null;
        string? error;
        try
        {
            var settings = _settings.Current;
            view = string.IsNullOrWhiteSpace(path) ? null : _preview.Get(id, path, compare ?? settings.Changes.Compare, settings);
            error = view is null ? "No file to preview." : null;
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException)
        {
            error = e.Message;
        }
        _page.Post(new ToPage.ChangeContent(requestId, view, error));
    }

    /// <summary>Which file a path Ctrl+clicked in a terminal means.</summary>
    private void Resolve(FromPage.ChangesResolve m)
    {
        var (path, line, error) = string.IsNullOrWhiteSpace(m.Text)
            ? ResolvedPath.NotAPath
            : _preview.Resolve(m.Id, m.Text, m.Remote, m.Cwd, m.WsCwd);
        _page.Post(new ToPage.ChangeResolved(m.RequestId, path, line, error));
    }
}

/// <summary>
/// git: the sidebar's project status (js/gitstatus.js), and the Git window (GitView.cs, js/gitwindow.js): a
/// repository's working tree, a file's diff, its history, one commit, its branches, and its menus' actions, on this PC
/// or on the server an SSH terminal is connected to.
/// </summary>
internal sealed class GitHandler(
    PageChannel page, ISettingsStore settings, TerminalSessions terminals, GitStatus gitStatus, LocalGitRunner localGit, IProcessRunner runner) : IMessageHandler
{
    private const int BytesPerKb = 1024;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.GitFolders>(m => Task.Run(() => PostStates(m.Folders ?? [], m.Force)));
        router.On<FromPage.GitViewStatus>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitView.Status(m.Folder ?? throw new ArgumentException("Not in a git repository."), git)));
        router.On<FromPage.GitViewDiff>(m =>
        {
            var maxBytes = settings.Current.Changes.MaxFileKb * (long)BytesPerKb;
            Answer(m.RequestId, m.Remote, action: false,
                git => GitView.Diff(git.CheckRoot(m.Root), new GitDiffTarget(m.Path ?? "", m.OldPath, m.Side ?? "", m.Hash), maxBytes, git));
        });
        router.On<FromPage.GitViewLog>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitView.Log(git.CheckRoot(m.Root), m.Skip, m.Limit, m.Ref, git)));
        router.On<FromPage.GitViewCommit>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitView.Commit(git.CheckRoot(m.Root), m.Hash ?? "", git)));
        router.On<FromPage.GitViewSearch>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitSearch.Search(git.CheckRoot(m.Root), m.Query, git)));
        router.On<FromPage.GitViewSearchCode>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitSearch.SearchCode(git.CheckRoot(m.Root), m.Query, m.Batch, git)));
        router.On<FromPage.GitViewBranches>(m => Answer(m.RequestId, m.Remote, action: false,
            git => GitView.Branches(git.CheckRoot(m.Root), git)));
        router.On<FromPage.GitViewAct>(m => Answer(m.RequestId, m.Remote, action: true, git =>
        {
            GitView.Act(git.CheckRoot(m.Root), m.Action ?? "", m.Path, m.Ref, m.HasCommits, git);
            return new GitActionDone(Ok: true);
        }));
    }

    /// <summary>The repositories these folders are in, for the sidebar.</summary>
    private void PostStates(IReadOnlyList<string> folders, bool force)
    {
        var states = folders.Distinct(StringComparer.OrdinalIgnoreCase).Take(GitStatus.MaxFolders)
            .Select(folder => new GitFolderState(folder, gitStatus.Of(folder, force))).ToList();
        page.Post(new ToPage.GitStates(states));
    }

    /// <summary>Runs a Git window request off the UI thread and answers it as gitview:result with the request's id.</summary>
    /// <param name="server">The SSH terminal whose server the repository is on (git runs there, through its host); null for this PC.</param>
    /// <param name="action">An action from a menu: its failure shows all git said; a view's, its first line.</param>
    private void Answer(string? requestId, string? server, bool action, Func<GitRunner, object> read) => _ = Task.Run(() =>
    {
        object? data = null;
        string? error = null;
        try
        {
            data = read(server is null ? localGit : ServerGit(server));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or InvalidOperationException)
        {
            error = action && e is GitFailedException failed ? failed.Detail : e.Message;
        }
        page.Post(new ToPage.GitViewResult(requestId, data, error));
    });

    /// <summary>git on the server an SSH terminal is connected to: its profile's ssh arguments and password helper.</summary>
    private SshGitRunner ServerGit(string terminal)
    {
        var ssh = SessionProfiles.SshCommand + " ";
        if (terminals.ProfileOf(terminal) is not { } profile || profile.Source != ProfileSources.Ssh ||
            !profile.CommandLine.StartsWith(ssh, StringComparison.OrdinalIgnoreCase))
        {
            throw new ArgumentException("This terminal isn't an SSH host or connection.");
        }
        return new SshGitRunner(runner, profile.CommandLine[ssh.Length..], profile.Environment);
    }
}

/// <summary>"New agent in worktree" (Worktrees.cs, js/worktree.js): creating, checking and removing an agent's worktree.</summary>
internal sealed class WorktreeHandler(PageChannel page, Worktrees worktrees) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.WorktreeCreate>(m => Answer(m.RequestId, () =>
        {
            if (string.IsNullOrEmpty(m.Folder) || !Directory.Exists(m.Folder))
            {
                throw new IOException("Pick a folder inside a git repository.");
            }
            var created = worktrees.Create(m.Folder, m.Branch ?? "");
            page.Post(new ToPage.WorktreeCreated(m.RequestId, created.Repo, created.Path, created.Branch, created.Copied));
        }));
        router.On<FromPage.WorktreeStatus>(m => Answer(m.RequestId, () =>
            page.Post(new ToPage.WorktreeState(m.RequestId, worktrees.Status(m.Repo ?? "", m.Path ?? "", m.Branch ?? "")))));
        router.On<FromPage.WorktreeRemove>(m => Answer(m.RequestId, () =>
        {
            worktrees.Remove(m.Repo ?? "", m.Path ?? "", m.Branch ?? "", m.DeleteBranch, m.Force);
            page.Post(new ToPage.WorktreeDone(m.RequestId));
        }));
    }

    /// <summary>Runs <paramref name="work"/> in the background; it answers, or its error does.</summary>
    private void Answer(string? requestId, Action work) => _ = Task.Run(() =>
    {
        try
        {
            work();
        }
        catch (Exception ex) when (Storage.IsFileError(ex))
        {
            page.Post(new ToPage.WorktreeFailed(requestId, ex.Message));
        }
    });
}

/// <summary>Workspace layouts (WorkspaceLayout.cs): exporting one to a .termilly.yml file, importing one, and finding one in a folder.</summary>
internal sealed class LayoutHandler(PageChannel page, IFileDialogs dialogs) : IMessageHandler
{
    private const string DefaultName = "workspace";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.LayoutExport>(m => ExportAsync(m.Name ?? DefaultName, m.Layout));
        router.On<FromPage.LayoutImport>(_ => ImportAsync());
        router.On<FromPage.LayoutProbe>(m => Probe(m.RequestId, m.Dir));
    }

    private async Task ImportAsync()
    {
        if (await dialogs.PickLayoutToOpenAsync().ConfigureAwait(false) is { } file)
        {
            Post(null, file, found: false);
        }
    }

    private async Task ExportAsync(string name, JsonElement layout)
    {
        var (normalized, _) = WorkspaceLayout.Normalize((JsonObject)JsonNode.Parse(layout.GetRawText())!, null);
        if (normalized is null)
        {
            page.Post(new ToPage.LayoutError("This workspace has no terminals to write down."));
            return;
        }
        if (await dialogs.PickLayoutToSaveAsync($"{string.Concat(name.Split(Path.GetInvalidFileNameChars()))}{WorkspaceLayout.FileName}").ConfigureAwait(false) is not { } file)
        {
            return;
        }
        try
        {
            AppPaths.WriteAtomically(file, WorkspaceLayoutWriter.ToYaml(normalized));
            page.Post(new ToPage.LayoutExported(file));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.LayoutError(e.Message));
        }
    }

    /// <summary>Looks for .termilly.yml in a folder a workspace is about to open in.</summary>
    private void Probe(string? requestId, string? dir)
    {
        var path = string.IsNullOrWhiteSpace(dir) ? null : Path.Combine(AppPaths.ResolveWorkingDirectory(dir), WorkspaceLayout.FileName);
        if (path is null || !File.Exists(path))
        {
            page.Post(new ToPage.NoLayoutFound(requestId));
            return;
        }
        Post(requestId, path, found: true);
    }

    /// <param name="found">The page probed a folder for its .termilly.yml (layout:found), rather than imported a file (layout).</param>
    private void Post(string? requestId, string path, bool found)
    {
        JsonObject? layout = null;
        IReadOnlyList<string> warnings;
        try
        {
            (layout, warnings) = WorkspaceLayout.Parse(File.ReadAllText(path), Path.GetDirectoryName(path)!);
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            warnings = [e.Message];
        }
        if (found)
        {
            page.Post(new ToPage.LayoutFound(requestId, layout, warnings, path));
        }
        else
        {
            page.Post(new ToPage.ImportedLayout(requestId, layout, warnings, path));
        }
    }
}
