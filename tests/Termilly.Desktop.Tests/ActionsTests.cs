using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class ActionsTests
{
    private static ActionSetting Web(string target) => new("t", "Test", target);

    private static ActionSetting Program(string target, string arguments) => new("t", "Test", target, arguments);

    private static Dictionary<string, string> Values(params (string Name, string Value)[] values) =>
        values.ToDictionary(v => v.Name, v => v.Value);

    [Fact]
    public void A_web_page_gets_the_selection_encoded()
    {
        var launch = Actions.Prepare(Web("https://www.google.com/search?q={selection}"), Values((ActionPlaceholders.Selection, "error: a & b #1")));
        Assert.Equal("https://www.google.com/search?q=error%3A%20a%20%26%20b%20%231", launch.Url!.AbsoluteUri);
        Assert.Null(launch.Program);
    }

    [Fact]
    public void A_repository_page_keeps_the_remote_as_it_is_and_the_branch_slashes()
    {
        var launch = Actions.Prepare(Web("{repo}/tree/{branch}"),
            Values((ActionPlaceholders.Repo, "https://github.com/termilly/termilly"), (ActionPlaceholders.Branch, "feature/a b")));
        Assert.Equal("https://github.com/termilly/termilly/tree/feature/a%20b", launch.Url!.AbsoluteUri);
    }

    [Fact]
    public void A_program_gets_each_argument_whole_even_with_spaces_and_quotes_in_the_selection()
    {
        var launch = Actions.Prepare(Program("code", "--goto \"{file}:{line}\" --new-window"),
            Values((ActionPlaceholders.File, @"C:\my files\a.cs"), (ActionPlaceholders.Line, "12"), (ActionPlaceholders.Folder, @"C:\repo")));
        Assert.Equal("code", launch.Program);
        Assert.Equal(["--goto", @"C:\my files\a.cs:12", "--new-window"], launch.Arguments!);
        Assert.Equal(@"C:\repo", launch.Folder);

        var search = Actions.Prepare(Program("grep", "-r {selection}"), Values((ActionPlaceholders.Selection, "a\" ; rm -rf /")));
        Assert.Equal(["-r", "a\" ; rm -rf /"], search.Arguments!);
    }

    [Theory]
    [InlineData("https://x/?q={selection}", ActionPlaceholders.Selection)]
    [InlineData("{repo}", ActionPlaceholders.Repo)]
    [InlineData("http://localhost:{port}", ActionPlaceholders.Port)]
    public void An_action_without_what_it_needs_says_so(string target, string missing)
    {
        Assert.Contains(missing, Actions.PlaceholdersIn(Web(target)));
        Assert.Throws<ActionUnavailableException>(() => Actions.Prepare(Web(target), Values()));
    }

    [Fact]
    public void Unknown_braces_are_left_alone() =>
        Assert.Equal("https://x/%7Bnot%7D?q=a", Actions.Prepare(Web("https://x/{not}?q={selection}"), Values((ActionPlaceholders.Selection, "a"))).Url!.AbsoluteUri);

    [Theory]
    [InlineData("https://example.com", true)]
    [InlineData("  http://localhost:{port}", true)]
    [InlineData("{repo}/pulls", true)]
    [InlineData("code", false)]
    [InlineData(@"C:\Tools\app.exe", false)]
    public void Web_pages_start_with_http_or_the_repository(string target, bool web) =>
        Assert.Equal(web, Actions.IsWebPage(target));

    [Theory]
    [InlineData("git@github.com:termilly/termilly.git", "https://github.com/termilly/termilly")]
    [InlineData("https://github.com/termilly/termilly.git", "https://github.com/termilly/termilly")]
    [InlineData("https://user:token@gitlab.com/group/sub/project", "https://gitlab.com/group/sub/project")]
    [InlineData("ssh://git@github.com/termilly/termilly", "https://github.com/termilly/termilly")]
    [InlineData(@"C:\repos\local", null)]
    [InlineData("", null)]
    public void A_remote_becomes_its_web_page(string remote, string? page) =>
        Assert.Equal(page, Actions.WebPageOfRemote(remote));

    [Fact]
    public void Arguments_split_like_a_shell_with_quotes_keeping_spaces() =>
        Assert.Equal(["-a", "two words", "it's", ""], Actions.SplitArguments("-a \"two words\" \"it's\" ''"));

    [Fact]
    public void A_selection_is_one_line_and_not_too_long()
    {
        Assert.Equal("a b c", Actions.CleanSelection("  a\n  b\tc "));
        Assert.Equal(Actions.MaxSelection, Actions.CleanSelection(new string('x', Actions.MaxSelection * 2))!.Length);
        Assert.Null(Actions.CleanSelection(" \n "));
    }

    [Fact]
    public void A_selected_file_is_found_from_the_folder_with_its_line()
    {
        var folder = Directory.CreateTempSubdirectory("termilly-actions").FullName;
        try
        {
            var file = Path.Combine(folder, "src", "a.ts");
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, "");
            Assert.Equal((file, "12"), Actions.FileOf("src/a.ts:12:5", folder));
            Assert.Equal((file, "7"), Actions.FileOf("src/a.ts(7,2)", folder));
            Assert.Equal((file, (string?)null), Actions.FileOf($"\"{file}\"", null));
            Assert.Null(Actions.FileOf("src/missing.ts:3", folder));
            Assert.Null(Actions.FileOf("src/a.ts", null));
        }
        finally
        {
            Directory.Delete(folder, true);
        }
    }

    [Fact]
    public void File_and_line_come_with_the_selection_when_it_names_a_file()
    {
        var file = Path.GetTempFileName();
        try
        {
            var values = Actions.Values(new ActionContext($"{file}:3", @"C:\x", 5173), "https://github.com/o/r", "main");
            Assert.Equal(file, values[ActionPlaceholders.File]);
            Assert.Equal("3", values[ActionPlaceholders.Line]);
            Assert.Equal("5173", values[ActionPlaceholders.Port]);
            Assert.Equal("main", values[ActionPlaceholders.Branch]);
        }
        finally
        {
            File.Delete(file);
        }
    }

    [Fact]
    public void No_saved_actions_means_termillys_own_and_bad_ones_are_dropped()
    {
        Assert.Equal(Actions.Defaults.Select(a => a.Id), new CommandSettings().Normalize().Actions!.Select(a => a.Id));
        var cleaned = new CommandSettings
        {
            Actions = [new("a", " Name ", " https://x "), new("a", "Again", "https://y"), new("b", "", "https://z"), new("c", "No target", " ")],
        }.Normalize().Actions!;
        var only = Assert.Single(cleaned);
        Assert.Equal(("Name", "https://x"), (only.Name, only.Target));
        Assert.Empty(new CommandSettings { Actions = [] }.Normalize().Actions!);
    }

    [Fact]
    public void A_first_start_without_a_settings_file_has_termillys_actions_too()
    {
        var missing = Path.Combine(Path.GetTempPath(), "termilly-no-settings-" + Guid.NewGuid().ToString("N"), "settings.json");
        Assert.Equal(Actions.Defaults.Count, SettingsFile.Load(missing).Commands.Actions!.Count);
    }
}
