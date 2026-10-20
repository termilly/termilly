using System.Runtime.Versioning;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>
/// The change preview's memory with Linux paths (these do nothing on Windows; Termilly.Desktop.Tests has the rest):
/// /home/... is this machine's, names are case-sensitive, and the home folder and folders right under / are too broad
/// to watch whole.
/// </summary>
[SupportedOSPlatform("linux")] // the tests themselves return early elsewhere
public sealed class ChangesLinuxTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly AppSettings _settings = new();

    public ChangesLinuxTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static AgentEvent Tool(string hookEvent, string file, string cwd) =>
        new("pane", hookEvent, "s1", "Edit", null, null, file, cwd);

    [Fact]
    public void Paths_stay_linux_paths()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        Assert.Equal("/home/me/proj/src/a.ts", ChangePaths.Normalize("/home/me/proj/src/../src/a.ts", null));
        Assert.Equal("/home/me/proj/src/a.ts", ChangePaths.Normalize("src/a.ts", "/home/me/proj"));
        Assert.Null(ChangePaths.Normalize("src/a.ts", null));
        Assert.True(ChangePaths.IsBroad("/"));
        Assert.True(ChangePaths.IsBroad("/tmp"));
        Assert.True(ChangePaths.IsBroad(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile)));
        Assert.False(ChangePaths.IsBroad("/home/me/proj"));
    }

    [Fact]
    public void An_edit_is_listed_relative_to_claudes_folder_and_diffed()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var (store, preview) = TestServices.Changes();
        var file = Path.Combine(_dir, "src", "a.ts");
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        File.WriteAllText(file, "one\ntwo\n");

        store.OnEvent(Tool("PreToolUse", file, _dir), _settings);
        File.WriteAllText(file, "one\n2\n");
        store.OnEvent(Tool("PostToolUse", file, _dir), _settings);

        var item = Assert.Single(preview.List("pane"));
        Assert.Equal((file, "src/a.ts", false, 1, 1), (item.Path, item.Display, item.Outside, item.Added, item.Removed));
        var view = preview.Get("pane", file, "session", _settings);
        Assert.Equal(("one\ntwo\n", "one\n2\n"), (view.Before, view.After));
        // Names differ by case on Linux: A.ts is another file.
        Assert.Equal("File not found.", preview.Get("pane", Path.Combine(_dir, "src", "A.ts"), "session", _settings).Error);
        // Ctrl+click on a printed path finds it.
        Assert.Equal(file, preview.Resolve("pane", "src/a.ts:3", remote: false).Path);
        Assert.Equal(file, preview.Resolve("pane", file, remote: false).Path);
    }

    [Fact]
    public void Files_in_a_folder_a_command_makes_are_listed_as_new()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var (store, preview) = TestServices.Changes();
        var tree = Path.Combine(_dir, "tree");
        // Claude works from / (too broad to watch); the command names a folder that isn't there yet.
        var command = new AgentEvent("pane", "PreToolUse", "s1", "Bash", null, null, null, "/", [Path.Combine(tree, "sub")]);

        store.OnEvent(command, _settings);
        for (var i = 1; i <= 3; i++)
        {
            Directory.CreateDirectory(Path.Combine(tree, $"sub{i}"));
            File.WriteAllText(Path.Combine(tree, $"sub{i}", $"file{i}.txt"), "made\n");
        }
        store.OnEvent(command with { Event = "PostToolUse" }, _settings);

        var items = preview.List("pane");
        Assert.Equal(3, items.Count);
        Assert.All(items, i => Assert.Equal("created", i.Kind));
    }
}
