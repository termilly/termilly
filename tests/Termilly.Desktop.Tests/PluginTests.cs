using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class PluginTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }

    private string Plugin(string folder, string manifest, string? script = null)
    {
        var dir = Path.Combine(_root, folder);
        Directory.CreateDirectory(dir);
        File.WriteAllText(Path.Combine(dir, "plugin.json"), manifest);
        if (script is not null)
        {
            File.WriteAllText(Path.Combine(dir, "main.js"), script);
        }
        return dir;
    }

    /// <summary>The repository's samples\plugins, found from this file (the build output may live elsewhere).</summary>
    private static string Samples([System.Runtime.CompilerServices.CallerFilePath] string here = "") =>
        Path.GetFullPath(Path.Combine(Path.GetDirectoryName(here)!, "..", "..", "samples", "plugins"));

    [Fact]
    public void The_sample_plugins_load()
    {
        var plugins = Plugins.Load(Samples());

        var helpers = Assert.Single(plugins, p => p.Id == "termilly.git-helpers");
        Assert.Null(helpers.Error);
        Assert.Contains("registerCommand", helpers.Script);
        var solarized = Assert.Single(plugins, p => p.Id == "termilly.solarized");
        Assert.Null(solarized.Error);
        Assert.Equal(["termilly.solarized/dark", "termilly.solarized/light"], solarized.Themes.Select(t => t["id"]!.GetValue<string>()));
        Assert.Equal("#002b36", solarized.Themes[0]["colors"]!["background"]!.GetValue<string>());
    }

    [Theory]
    [InlineData("{ nope", "can't be read")]
    [InlineData("""{ "apiVersion": 1, "id": "Bad Id", "main": "main.js" }""", "needs an \"id\"")]
    [InlineData("""{ "id": "a.b", "main": "main.js" }""", "apiVersion")]
    [InlineData("""{ "apiVersion": 2, "id": "a.b", "main": "main.js" }""", "needs plugin API 2")]
    [InlineData("""{ "apiVersion": 1, "id": "a.b", "main": "../outside.js" }""", "isn't in the plugin's folder")]
    [InlineData("""{ "apiVersion": 1, "id": "a.b" }""", "neither themes nor a script")]
    [InlineData("""{ "apiVersion": 1, "id": "a.b", "themes": [{ "id": "x", "colors": { "background": "url(evil)" } }] }""", "Each theme needs")]
    public void Broken_plugins_are_disabled_with_the_reason(string manifest, string reason)
    {
        var plugin = Plugins.Read(Plugin("p", manifest, "1"));
        Assert.Contains(reason, plugin.Error);
        Assert.Null(plugin.Script);
    }

    [Fact]
    public void Unknown_colour_keys_are_dropped_and_duplicate_ids_rejected()
    {
        Plugin("a", """{ "apiVersion": 1, "id": "same", "themes": [{ "id": "t", "colors": { "red": "#f00", "fontFamily": "#fff", "blue": "rgb(0, 0, 255)" } }] }""");
        Plugin("b", """{ "apiVersion": 1, "id": "same", "main": "main.js" }""", "1");

        var plugins = Plugins.Load(_root);

        Assert.Equal(["blue", "red"], plugins[0].Themes[0]["colors"]!.AsObject().Select(kv => kv.Key).Order());
        Assert.Contains("already has the id", plugins[1].Error);
    }

    [Fact]
    public void No_plugins_folder_means_no_plugins() =>
        Assert.Empty(Plugins.Load(Path.Combine(_root, "missing")));
}
