using Termilly.Desktop;
using Termilly.Desktop.Messaging;

namespace Termilly.Core.Tests;

/// <summary>A repository's snippets (.termilly/snippets.yml, .termilly.yml) and VS Code tasks, read and written.</summary>
public sealed class RepoSnippetsTests : IDisposable
{
    private readonly string _repo = Path.Combine(Path.GetTempPath(), "termilly-repo-" + Guid.NewGuid().ToString("N"));

    public RepoSnippetsTests()
    {
        Directory.CreateDirectory(Path.Combine(_repo, ".git", "info"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_repo))
        {
            foreach (var file in Directory.EnumerateFileSystemEntries(_repo, "*", SearchOption.AllDirectories))
            {
                File.SetAttributes(file, FileAttributes.Normal);
            }
            Directory.Delete(_repo, recursive: true);
        }
    }

    private string Write(string relative, string text)
    {
        var path = Path.Combine(_repo, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        return path;
    }

    [Fact]
    public void A_folder_deep_in_a_repository_finds_its_root()
    {
        var deep = Path.Combine(_repo, "src", "app");
        Directory.CreateDirectory(deep);

        Assert.Equal(_repo, RepoSnippets.RootOf(deep));
        Assert.Null(RepoSnippets.RootOf(Path.Combine(_repo, "missing")));
    }

    [Fact]
    public void Snippets_written_are_read_back_the_same()
    {
        RepoSnippet[] snippets =
        [
            new("Check", "npm run check", "Literals and sizes"),
            new("Push", "git push optiplex {{branch}} && git push mac {{branch}}"),
            new("Open site", "start http://{{host=127.0.0.1}}:8791/", Enter: false),
        ];

        RepoSnippets.Write(_repo, snippets, onlyMe: false);
        var found = RepoSnippets.Read(null, _repo);

        Assert.Equal(_repo, found.Root);
        Assert.Equal(["Check", "Push", "Open site"], found.Snippets.Select(s => s.Name));
        Assert.Equal("git push optiplex {{branch}} && git push mac {{branch}}", found.Snippets[1].Command);
        Assert.Equal("Literals and sizes", found.Snippets[0].Description);
        Assert.False(found.Snippets[2].Enter);
        Assert.Null(found.Snippets[0].Enter);
        Assert.Empty(found.Warnings);
    }

    [Fact]
    public void Only_for_me_puts_the_folder_in_git_exclude_and_takes_it_out_again()
    {
        Write(".git/info/exclude", "# git's own\nnode_modules/\n");

        RepoSnippets.Write(_repo, [new("a", "echo a")], onlyMe: true);
        Assert.True(RepoSnippets.IsOnlyMe(_repo));
        RepoSnippets.Write(_repo, [new("a", "echo a")], onlyMe: false);

        Assert.False(RepoSnippets.IsOnlyMe(_repo));
        Assert.Equal("# git's own\nnode_modules/\n", File.ReadAllText(Path.Combine(_repo, ".git", "info", "exclude")));
    }

    [Fact]
    public void No_snippets_left_removes_the_file_and_the_empty_folder()
    {
        RepoSnippets.Write(_repo, [new("a", "echo a")], onlyMe: false);
        RepoSnippets.Write(_repo, [], onlyMe: false);

        Assert.False(Directory.Exists(Path.Combine(_repo, RepoSnippets.Folder)));
    }

    [Fact]
    public void A_folder_that_is_not_a_repository_root_is_never_written_to()
    {
        var sub = Path.Combine(_repo, "sub");
        Directory.CreateDirectory(sub);

        Assert.Throws<IOException>(() => RepoSnippets.Write(sub, [new("a", "echo a")], onlyMe: false));
    }

    [Fact]
    public void The_layout_files_snippets_are_listed_as_shared()
    {
        Write(".termilly.yml", "name: api\nsnippets:\n  - name: Logs\n    command: kubectl logs -f {{pod}}\n");

        var found = RepoSnippets.Read(null, _repo);

        Assert.Equal("Logs", Assert.Single(found.Shared).Name);
    }

    [Fact]
    public void Tasks_are_read_with_comments_args_quoted_and_variables_filled()
    {
        Write(".vscode/tasks.json", """
            // VS Code's own file: comments and trailing commas
            {
              "version": "2.0.0",
              "tasks": [
                { "label": "build", "type": "shell", "command": "dotnet", "args": ["build", "${workspaceFolder}/my app.sln"],
                  "group": { "kind": "build", "isDefault": true }, },
                { "label": "serve", "type": "process", "command": "node tools/serve.mjs ${input:port}",
                  "options": { "cwd": "${workspaceFolder}/research", "env": { "MODE": "dev" } } },
                { "label": "all", "dependsOn": ["build", "serve"] },
                { "label": "lint", "type": "npm", "script": "lint" },
                { "label": "secret", "command": "echo hi", "hide": true },
              ],
              "inputs": [
                { "id": "port", "type": "promptString", "description": "Port", "default": "8790" },
                { "id": "env", "type": "pickString", "options": ["dev", { "label": "Production", "value": "prod" }] },
              ],
            }
            """);

        var found = RepoSnippets.Read(null, _repo);

        Assert.Empty(found.Warnings);
        Assert.Equal(["build", "serve", "all", "secret"], found.Tasks.Select(t => t.Label));
        var build = found.Tasks[0];
        Assert.Equal($"dotnet build \"{_repo}/my app.sln\"", build.Command);
        Assert.Equal("build", build.Group);
        Assert.True(build.IsDefault);
        var serve = found.Tasks[1];
        Assert.Equal("node tools/serve.mjs {{port}}", serve.Command);
        Assert.Equal($"{_repo}/research", serve.Cwd);
        Assert.Equal("dev", serve.Env!["MODE"]);
        Assert.Equal(["build", "serve"], found.Tasks[2].DependsOn);
        Assert.True(found.Tasks[3].Hidden);
        Assert.Equal(["8790", null], found.Inputs.Select(i => i.Default));
        Assert.Equal(["dev", "prod"], found.Inputs[1].Options!);
    }

    [Fact]
    public void An_arg_is_quoted_after_its_variables_are_filled_and_an_empty_one_is_kept()
    {
        var root = Path.Combine(_repo, "my repo");
        var (tasks, _) = VsCodeTasks.Parse("""
            { "tasks": [ { "label": "run", "command": "node", "args": ["${workspaceFolder}/build.js", ""] } ] }
            """, root, []);

        Assert.Equal($"node \"{root}/build.js\" \"\"", Assert.Single(tasks).Command);
    }

    [Fact]
    public void A_task_takes_this_systems_command()
    {
        var os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "osx" : "linux";
        var (tasks, _) = VsCodeTasks.Parse($$"""
            { "tasks": [ { "label": "open", "command": "xdg-open .", "{{os}}": { "command": "here" } } ] }
            """, _repo, []);

        Assert.Equal("here", Assert.Single(tasks).Command);
    }

    [Fact]
    public void A_workspace_files_tasks_run_in_its_first_folder_with_its_named_folders_filled()
    {
        var api = Directory.CreateDirectory(Path.Combine(_repo, "services", "api")).FullName;
        var web = Directory.CreateDirectory(Path.Combine(_repo, "web")).FullName;
        Write("app.code-workspace", """
            // VS Code's own file: comments and trailing commas
            {
              "folders": [ { "path": "services/api" }, { "name": "Front end", "path": "./web/" }, ],
              "settings": {},
              "tasks": {
                "version": "2.0.0",
                "tasks": [
                  { "label": "build", "command": "dotnet build ${workspaceFolder}", "group": "build" },
                  { "label": "web", "command": "npm start", "options": { "cwd": "${workspaceFolder:Front end}" } },
                  { "label": "docs", "command": "make", "options": { "cwd": "docs" } },
                  { "label": "where", "command": "echo ${workspaceFolderBasename} ${workspaceFolder:api} ${workspaceFolder:nope}" },
                  { "label": "both", "dependsOn": ["build", "web"] },
                ],
                "inputs": [ { "id": "port", "type": "promptString" } ],
              },
            }
            """);

        var found = RepoSnippets.Read(null, _repo);

        Assert.Empty(found.Warnings);
        Assert.Equal(["build", "web", "docs", "where", "both"], found.Tasks.Select(t => t.Label));
        Assert.All(found.Tasks, t => Assert.Equal("app.code-workspace", t.File));
        Assert.Equal($"dotnet build {api}", found.Tasks[0].Command);
        Assert.Equal(api, found.Tasks[0].Cwd);
        Assert.Equal(web, found.Tasks[1].Cwd);
        Assert.Equal(Path.Combine(api, "docs"), found.Tasks[2].Cwd);
        Assert.Equal($"echo api {api} ${{workspaceFolder:nope}}", found.Tasks[3].Command);
        Assert.Equal("app.code-workspace", Assert.Single(found.Inputs).File);
    }

    [Fact]
    public void Tasks_json_and_workspace_tasks_are_listed_each_with_its_own_file()
    {
        Write(".vscode/tasks.json", """{ "tasks": [ { "label": "build", "command": "make" } ], "inputs": [ { "id": "a", "type": "promptString" } ] }""");
        Write("b.CODE-WORKSPACE", """{ "folders": [ { "path": "." } ], "tasks": { "tasks": [ { "label": "build", "command": "make all" } ] } }""");
        Write("a.code-workspace", """{ "folders": [] }""");
        Write("sub/c.code-workspace", """{ "tasks": { "tasks": [ { "label": "deep", "command": "x" } ] } }""");

        var found = RepoSnippets.Read(null, _repo);

        Assert.Equal([(".vscode/tasks.json", "make"), ("b.CODE-WORKSPACE", "make all")], found.Tasks.Select(t => (t.File, t.Command)));
        Assert.Null(found.Tasks[0].Cwd);
        Assert.Equal(_repo, found.Tasks[1].Cwd);
        Assert.Equal(".vscode/tasks.json", Assert.Single(found.Inputs).File);
    }

    [Fact]
    public void A_folder_name_is_taken_as_written_and_a_folder_listed_again_is_left_out()
    {
        Directory.CreateDirectory(Path.Combine(_repo, "api"));
        Write("n.code-workspace", """
            { "folders": [ { "name": " API ", "path": "api" }, { "name": "again", "path": "api/" } ],
              "tasks": { "tasks": [ { "label": "x", "command": "${workspaceFolder: API } ${workspaceFolder:API} ${workspaceFolder:again}" } ] } }
            """);

        var api = Path.Combine(_repo, "api");
        Assert.Equal($"{api} ${{workspaceFolder:API}} ${{workspaceFolder:again}}", Assert.Single(RepoSnippets.Read(null, _repo).Tasks).Command);
    }

    [Fact]
    public void A_workspace_without_folders_leaves_its_folder_variables_as_written()
    {
        Write("bare.code-workspace", """{ "tasks": { "tasks": [ { "label": "x", "command": "ls ${workspaceFolder}" } ] } }""");

        var task = Assert.Single(RepoSnippets.Read(null, _repo).Tasks);

        Assert.Equal("ls ${workspaceFolder}", task.Command);
        Assert.Null(task.Cwd);
    }

    [Fact]
    public void A_workspace_folder_can_be_a_file_uri_and_others_are_left_out()
    {
        var lib = Directory.CreateDirectory(Path.Combine(_repo, "my lib")).FullName;
        var uri = new Uri(lib).AbsoluteUri;
        Write("u.code-workspace", $$"""
            { "folders": [ { "uri": "vscode-remote://ssh-remote+box/home/me/x" }, { "uri": "{{uri}}" } ],
              "tasks": { "tasks": [ { "label": "x", "command": "ls" } ] } }
            """);

        Assert.Equal(lib, Assert.Single(RepoSnippets.Read(null, _repo).Tasks).Cwd);
    }

    [Fact]
    public void A_windows_drive_uri_as_vs_code_writes_it_is_that_drives_folder()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        var drive = _repo[..1].ToLowerInvariant();
        var rest = _repo[2..].Replace('\\', '/');
        Write("w.code-workspace", $$"""
            { "folders": [ { "uri": "file:///{{drive}}%3A{{rest}}" } ], "tasks": { "tasks": [ { "label": "x", "command": "ls" } ] } }
            """);

        Assert.Equal(_repo, Assert.Single(RepoSnippets.Read(null, _repo).Tasks).Cwd, ignoreCase: true);
    }

    [Fact]
    public void A_broken_workspace_file_is_a_warning_naming_it()
    {
        Write("team.code-workspace", "{ \"tasks\": ");

        var found = RepoSnippets.Read(null, _repo);

        Assert.Empty(found.Tasks);
        Assert.Contains(found.Warnings, w => w.Contains("team.code-workspace", StringComparison.Ordinal));
    }

    [Fact]
    public void Past_the_most_workspace_files_read_a_warning_says_so()
    {
        for (var i = 0; i <= VsCodeWorkspace.MaxFiles; i++)
        {
            Write($"w{i}.code-workspace", $$"""{ "tasks": { "tasks": [ { "label": "t{{i}}", "command": "x" } ] } }""");
        }

        var found = RepoSnippets.Read(null, _repo);

        Assert.Equal(VsCodeWorkspace.MaxFiles, found.Tasks.Count);
        Assert.Single(found.Warnings);
    }

    [Fact]
    public void A_broken_tasks_file_is_a_warning_not_a_failure()
    {
        Write(".vscode/tasks.json", "{ \"tasks\": [ ");

        var found = RepoSnippets.Read(null, _repo);

        Assert.Empty(found.Tasks);
        Assert.Contains(found.Warnings, w => w.Contains("tasks.json", StringComparison.Ordinal));
    }
}
