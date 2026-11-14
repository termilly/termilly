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
    public void A_task_takes_this_systems_command()
    {
        var os = OperatingSystem.IsWindows() ? "windows" : OperatingSystem.IsMacOS() ? "osx" : "linux";
        var (tasks, _) = VsCodeTasks.Parse($$"""
            { "tasks": [ { "label": "open", "command": "xdg-open .", "{{os}}": { "command": "here" } } ] }
            """, _repo, []);

        Assert.Equal("here", Assert.Single(tasks).Command);
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
