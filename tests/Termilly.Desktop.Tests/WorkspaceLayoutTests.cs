using System.IO;
using System.Text.Json.Nodes;

namespace Termilly.Desktop.Tests;

public sealed class WorkspaceLayoutTests
{
    private const string Project = @"C:\work\api";

    [Fact]
    public void A_layout_file_is_read_with_folders_made_absolute()
    {
        var (layout, warnings) = WorkspaceLayout.Parse("""
            version: 1
            name: api
            color: "#7EE787"
            cwd: .
            layout:
              split: row
              ratio: 0.6
              panes:
                - terminal: { name: server, profile: pwsh, command: npm run dev, tags: [dev], env: { NODE_ENV: development, PORT: 3000 } }
                - split: column
                  panes:
                    - terminal: { name: tests, cwd: ./tests, command: npm test }
                    - terminal: { name: shell }
            """, Project);

        Assert.Empty(warnings);
        Assert.Equal("api", layout!["name"]!.GetValue<string>());
        Assert.Equal("#7ee787", layout["color"]!.GetValue<string>());
        Assert.Equal(Project, layout["cwd"]!.GetValue<string>());
        var root = layout["layout"]!;
        Assert.Equal(("row", 0.6), (root["split"]!.GetValue<string>(), root["ratio"]!.GetValue<double>()));
        var server = root["panes"]![0]!["terminal"]!;
        Assert.Equal("npm run dev", server["command"]!.GetValue<string>());
        Assert.Equal("3000", server["env"]!["PORT"]!.GetValue<string>());
        Assert.Equal(Path.Combine(Project, "tests"), root["panes"]![1]!["panes"]![0]!["terminal"]!["cwd"]!.GetValue<string>());
    }

    [Fact]
    public void A_plain_list_of_terminals_goes_side_by_side()
    {
        var (layout, _) = WorkspaceLayout.Parse("terminals:\n  - name: a\n  - name: b\n  - name: c\n", Project);
        var root = layout!["layout"]!;
        Assert.Equal("row", root["split"]!.GetValue<string>());
        Assert.Equal("a", root["panes"]![0]!["terminal"]!["name"]!.GetValue<string>());
        Assert.Equal("c", root["panes"]![1]!["panes"]![1]!["terminal"]!["name"]!.GetValue<string>());
    }

    [Fact]
    public void Terminals_as_tabs_are_read_and_a_group_of_one_is_a_plain_terminal()
    {
        var (layout, warnings) = WorkspaceLayout.Parse("""
            layout:
              split: row
              panes:
                - tabs:
                    - terminal: { name: server }
                    - terminal: { name: logs }
                    - split: row
                  active: 1
                - tabs:
                    - terminal: { name: alone }
            """, Project);
        var root = layout!["layout"]!;
        var group = root["panes"]![0]!;
        Assert.Equal(2, group["tabs"]!.AsArray().Count);
        Assert.Equal("logs", group["tabs"]![1]!["terminal"]!["name"]!.GetValue<string>());
        Assert.Equal(1, group["active"]!.GetValue<int>());
        Assert.Equal("alone", root["panes"]![1]!["terminal"]!["name"]!.GetValue<string>());
        Assert.Contains(warnings, w => w.Contains("A tab holds one terminal"));
    }

    [Fact]
    public void A_projects_snippets_are_read()
    {
        var (layout, warnings) = WorkspaceLayout.Parse("""
            snippets:
              - name: Tail pod logs
                command: kubectl logs -f {{pod}} -n {{namespace=default}}
                description: follows one pod
              - name: Half typed
                command: git commit -m
                enter: false
              - name: Broken
            terminals:
              - name: a
            """, Project);

        var snippets = layout!["snippets"]!.AsArray();
        Assert.Equal(2, snippets.Count);
        Assert.Equal("kubectl logs -f {{pod}} -n {{namespace=default}}", snippets[0]!["command"]!.GetValue<string>());
        Assert.False(snippets[1]!["enter"]!.GetValue<bool>());
        Assert.Contains(warnings, w => w.Contains("snippet without a command"));
    }

    [Fact]
    public void Notes_on_the_workspace_and_its_terminals_are_kept()
    {
        var (layout, warnings) = WorkspaceLayout.Parse("""
            notes: |
              Staging DB is read-only until Friday.
              Ask #ops before restarting.
            terminals:
              - name: db
                note: needs sudo -u deploy
            """, Project);

        Assert.Empty(warnings);
        Assert.StartsWith("Staging DB is read-only", layout!["notes"]!.GetValue<string>());
        Assert.Equal("needs sudo -u deploy", layout["layout"]!["terminal"]!["note"]!.GetValue<string>());
    }

    [Fact]
    public void Unknown_keys_and_bad_values_are_warnings_not_failures()
    {
        var (layout, warnings) = WorkspaceLayout.Parse("""
            name: x
            colour: red
            color: red
            layout:
              split: diagonal
              panes:
                - terminal: { name: a, shell: bash }
                - terminal: { name: b, env: { "BAD=NAME": 1 } }
            """, Project);

        Assert.NotNull(layout);
        Assert.Equal("row", layout!["layout"]!["split"]!.GetValue<string>());
        Assert.Contains(warnings, w => w.Contains("\"colour\""));
        Assert.Contains(warnings, w => w.Contains("\"shell\""));
        Assert.Contains(warnings, w => w.Contains("diagonal"));
        Assert.Contains(warnings, w => w.Contains("#8b7bff"));
        Assert.Contains(warnings, w => w.Contains("BAD=NAME"));
    }

    [Theory]
    [InlineData("layout: [")]
    [InlineData("just text")]
    [InlineData("name: nothing")]
    public void Files_without_terminals_are_refused_with_a_reason(string yaml)
    {
        var (layout, warnings) = WorkspaceLayout.Parse(yaml, Project);
        Assert.Null(layout);
        Assert.NotEmpty(warnings);
    }

    [Fact]
    public void Exported_yaml_reads_back_the_same_and_keeps_no_secrets()
    {
        var page = JsonNode.Parse("""
            { "version": 1, "name": "api", "layout": { "split": "column", "ratio": 0.5, "panes": [
              { "terminal": { "name": "server", "command": "npm run dev", "env": { "NODE_ENV": "development", "API_TOKEN": "abc123", "GH": "ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } } },
              { "terminal": { "name": "shell", "tags": ["prod"] } } ] } }
            """)!.AsObject();
        var (normalized, _) = WorkspaceLayout.Normalize(page, null);

        var yaml = WorkspaceLayoutWriter.ToYaml(normalized!);
        var (back, warnings) = WorkspaceLayout.Parse(yaml, Project);

        Assert.Empty(warnings);
        Assert.DoesNotContain("abc123", yaml);
        Assert.DoesNotContain("ghp_", yaml);
        var env = back!["layout"]!["panes"]![0]!["terminal"]!["env"]!;
        Assert.Equal("development", env["NODE_ENV"]!.GetValue<string>());
        Assert.Equal("<set me>", env["API_TOKEN"]!.GetValue<string>());
        Assert.Equal("prod", back["layout"]!["panes"]![1]!["terminal"]!["tags"]![0]!.GetValue<string>());
    }
}
