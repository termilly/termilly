using System.IO;
using System.Text;

namespace Termilly.Desktop.Tests;

public sealed class ChangesTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly AppSettings _settings = new();

    public ChangesTests() => Directory.CreateDirectory(_dir);

    public void Dispose()
    {
        foreach (var file in Directory.EnumerateFiles(_dir, "*", SearchOption.AllDirectories))
        {
            File.SetAttributes(file, FileAttributes.Normal); // git makes its objects read-only
        }
        Directory.Delete(_dir, recursive: true);
    }

    private string Write(string name, string text)
    {
        var path = Path.GetFullPath(Path.Combine(_dir, name));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        return path;
    }

    private static AgentEvent Tool(string hookEvent, string file, string tool = "Edit", string? cwd = null, string? session = "s1") =>
        new("pane", hookEvent, session, tool, null, null, file, cwd);

    /// <summary>Claude's edit as the hooks see it: the copy before, the change on disk, the copy after.</summary>
    private HookReply Edit(ChangeStore store, string path, string newText, string tool = "Edit", AppSettings? settings = null)
    {
        settings ??= _settings;
        store.OnEvent(Tool("PreToolUse", path, tool), settings);
        File.WriteAllText(path, newText);
        return store.OnEvent(Tool("PostToolUse", path, tool, _dir), settings);
    }

    private static string[] Ops(ChangeView view) => view.Ops.Select(o => $"{o[0]}:{o[1]}").ToArray();

    // ---- The line diff ----

    [Fact]
    public void Identical_texts_have_no_changes()
    {
        var diff = LineDiff.Diff("a\nb\n", "a\nb\n");
        Assert.Equal([new DiffRun(0, 2)], diff.Runs);
        Assert.Equal((0, 0, false), (diff.Added, diff.Removed, diff.EolOnly));
    }

    [Fact]
    public void An_added_line_in_the_middle_is_one_insert() =>
        Assert.Equal([new DiffRun(0, 2), new DiffRun(2, 1), new DiffRun(0, 2)], LineDiff.Diff("a\nb\nc\nd\n", "a\nb\nx\nc\nd\n").Runs);

    [Fact]
    public void Changed_blocks_show_removed_lines_before_added_ones()
    {
        var diff = LineDiff.Diff("a\nold1\nb\nold2\nc", "a\nnew1\nb\nnew2a\nnew2b\nc");
        Assert.Equal([new DiffRun(0, 1), new DiffRun(1, 1), new DiffRun(2, 1), new DiffRun(0, 1), new DiffRun(1, 1), new DiffRun(2, 2), new DiffRun(0, 1)], diff.Runs);
        Assert.Equal((3, 2), (diff.Added, diff.Removed));
    }

    [Fact]
    public void A_new_or_emptied_file_is_all_added_or_all_removed()
    {
        Assert.Equal([new DiffRun(2, 3)], LineDiff.Diff("", "a\nb\nc\n").Runs);
        Assert.Equal([new DiffRun(1, 2)], LineDiff.Diff("a\nb", "").Runs);
    }

    [Fact]
    public void Unrelated_large_files_fall_back_to_one_replacement_quickly()
    {
        var a = string.Join('\n', Enumerable.Range(0, 50_000).Select(i => $"a{i}"));
        var b = string.Join('\n', Enumerable.Range(0, 50_000).Select(i => $"b{i}"));
        var watch = System.Diagnostics.Stopwatch.StartNew();
        var diff = LineDiff.Diff(a, b);
        Assert.Equal([new DiffRun(1, 50_000), new DiffRun(2, 50_000)], diff.Runs);
        Assert.True(watch.Elapsed < TimeSpan.FromSeconds(5), $"took {watch.Elapsed}");
    }

    [Fact]
    public void Line_endings_alone_are_reported_as_such()
    {
        var diff = LineDiff.Diff("a\r\nb\r\n", "a\nb\n");
        Assert.Equal((0, 0, true), (diff.Added, diff.Removed, diff.EolOnly));
    }

    [Fact]
    public void The_diff_turns_one_text_into_the_other()
    {
        var random = new Random(7);
        for (var round = 0; round < 200; round++)
        {
            var a = Enumerable.Range(0, random.Next(0, 30)).Select(_ => "l" + random.Next(0, 6)).ToArray();
            var b = Enumerable.Range(0, random.Next(0, 30)).Select(_ => "l" + random.Next(0, 6)).ToArray();
            var diff = LineDiff.Diff(a, b);
            var rebuilt = new List<string>();
            int i = 0, j = 0;
            foreach (var run in diff.Runs)
            {
                switch (run.Kind)
                {
                    case 0: rebuilt.AddRange(a.Skip(i).Take(run.Count)); i += run.Count; j += run.Count; break;
                    case 1: i += run.Count; break;
                    case 2: rebuilt.AddRange(b.Skip(j).Take(run.Count)); j += run.Count; break;
                }
            }
            Assert.Equal((a.Length, b.Length), (i, j));
            Assert.Equal(b, rebuilt);
        }
    }

    // ---- What the store keeps ----

    [Fact]
    public void A_copy_taken_before_the_edit_is_what_the_preview_compares_against()
    {
        var (store, preview) = TestServices.Changes();
        var path = Write("src/a.ts", "one\ntwo\n");

        Assert.Equal(HookReply.Ok, Edit(store, path, "one\n2\n"));

        var view = preview.Get("pane", path, "session", _settings);
        Assert.Equal(("one\ntwo\n", "one\n2\n", "modified", "snapshot"), (view.Before, view.After, view.Kind, view.Source));
        Assert.Equal(["0:1", "1:1", "2:1"], Ops(view));
        var item = preview.List("pane").Single();
        Assert.Equal((@"src\a.ts", false, 1, 1, 1), (item.Display, item.Outside, item.Edits, item.Added, item.Removed));
    }

    [Fact]
    public void Two_edits_compare_since_the_first_or_only_the_last()
    {
        var (store, preview) = TestServices.Changes();
        var path = Write("a.txt", "v1\n");
        Edit(store, path, "v2\n");
        Edit(store, path, "v3\n");

        Assert.Equal(("v1\n", "v3\n"), (preview.Get("pane", path, "session", _settings).Before, preview.Get("pane", path, "session", _settings).After));
        Assert.Equal("v2\n", preview.Get("pane", path, "last", _settings).Before);
        Assert.Equal(2, preview.List("pane").Single().Edits);
    }

    [Fact]
    public void A_new_file_has_no_before_and_a_deleted_one_no_after()
    {
        var (store, preview) = TestServices.Changes();
        var path = Path.Combine(_dir, "new.txt");
        store.OnEvent(Tool("PreToolUse", path, "Write"), _settings);
        File.WriteAllText(path, "hello\n");
        store.OnEvent(Tool("PostToolUse", path, "Write"), _settings);

        var view = preview.Get("pane", path, "session", _settings);
        Assert.Equal(("created", null, "hello\n"), (view.Kind, view.Before, view.After));
        Assert.Equal(["2:1"], Ops(view));
        var item = preview.List("pane").Single();
        Assert.Equal(("created", 1, 0), (item.Kind, item.Added, item.Removed)); // counted, not +0 −0

        Edit(store, path, "bye\n");
        store.OnEvent(Tool("PreToolUse", path, "Edit"), _settings);
        File.Delete(path);
        store.OnEvent(Tool("PostToolUse", path, "Edit"), _settings);
        Assert.Equal("deleted", preview.Get("pane", path, "last", _settings).Kind);
    }

    [Fact]
    public void Binary_and_too_large_files_keep_only_their_size()
    {
        var (store, preview) = TestServices.Changes();
        var binary = Path.Combine(_dir, "b.bin");
        File.WriteAllBytes(binary, [1, 0, 2]);
        store.OnEvent(Tool("PreToolUse", binary), _settings);
        File.WriteAllBytes(binary, [1, 0, 2, 3]);
        store.OnEvent(Tool("PostToolUse", binary), _settings);
        var view = preview.Get("pane", binary, "session", _settings);
        Assert.Equal(("binary", null, null, 3L, 4L), (view.Kind, view.Before, view.After, view.BeforeSize, view.AfterSize));

        var small = _settings with { Changes = _settings.Changes with { MaxFileKb = 512 } };
        var big = Write("big.txt", new string('x', 600 * 1024));
        store.OnEvent(Tool("PreToolUse", big), small);
        store.OnEvent(Tool("PostToolUse", big), small);
        var large = preview.Get("pane", big, "session", small);
        Assert.Equal(("large", null), (large.Kind, large.After));
        Assert.StartsWith("Too large to preview", large.Note);
    }

    [Fact]
    public void Utf16_files_are_text_and_keep_their_encoding()
    {
        var path = Path.Combine(_dir, "u.txt");
        File.WriteAllText(path, "héllo\n", Encoding.Unicode);
        Assert.Equal("héllo\n", Blob.Read(path, 1 << 20).Text());
    }

    [Fact]
    public void Total_memory_is_capped_by_dropping_the_oldest_copies()
    {
        var (store, preview) = TestServices.Changes(maxTotalBytes: 3000);
        var first = Write("first.txt", new string('a', 1000));
        var second = Write("second.txt", new string('b', 1000));
        Edit(store, first, new string('c', 1000));
        Thread.Sleep(20);
        Edit(store, second, new string('d', 1000));

        var items = preview.List("pane");
        Assert.Equal(2, items.Count); // the list stays; only the copies go
        var evicted = preview.Get("pane", first, "session", _settings);
        Assert.Equal("git", evicted.Source);
        Assert.Equal("snapshot", preview.Get("pane", second, "session", _settings).Source);
    }

    [Fact]
    public void A_new_session_keeps_the_list_unless_set_to_start_a_new_one()
    {
        var (store, preview) = TestServices.Changes();
        var path = Write("a.txt", "1");
        Edit(store, path, "2");

        store.OnEvent(new AgentEvent("pane", "SessionStart", "s2", null, null, null), _settings);
        Assert.Single(preview.List("pane")); // by default the list stays until it's cleared

        var perSession = _settings with { Changes = _settings.Changes with { Keep = "session" } };
        store.OnEvent(new AgentEvent("pane", "SessionStart", "s2", null, null, null), perSession);
        Assert.Single(preview.List("pane")); // the same session
        store.OnEvent(new AgentEvent("pane", "SessionStart", "s3", null, null, null), perSession);
        Assert.Empty(preview.List("pane"));
    }

    [Fact]
    public void Clearing_a_file_or_the_whole_list_says_so()
    {
        var (store, preview) = TestServices.Changes();
        var changed = new List<string>();
        var a = Write("a.txt", "1");
        var b = Write("b.txt", "1");
        Edit(store, a, "2");
        Edit(store, b, "2");
        store.Changed += changed.Add;

        store.Clear("pane", a.Replace('\\', '/'));
        Assert.Equal([b], preview.List("pane").Select(i => i.Path));
        store.Clear("pane", null);
        Assert.Empty(preview.List("pane"));
        store.Clear("other", null); // a terminal with no list: nothing happens
        Assert.Equal(["pane", "pane"], changed);
    }

    [Fact]
    public void Closing_the_terminal_forgets_its_changes_and_says_so()
    {
        var (store, preview) = TestServices.Changes();
        var changed = new List<string>();
        store.Changed += changed.Add;
        Edit(store, Write("a.txt", "1"), "2");
        store.Forget("pane");

        Assert.Empty(preview.List("pane"));
        Assert.Equal(["pane", "pane"], changed);
    }

    [Fact]
    public void A_denied_edit_leaves_no_entry()
    {
        var (store, preview) = TestServices.Changes();
        var path = Write("a.txt", "1");
        store.OnEvent(Tool("PreToolUse", path), _settings);
        store.OnEvent(new AgentEvent("pane", "Stop", "s1", null, null, null), _settings);
        Assert.Empty(preview.List("pane"));
    }

    [Fact]
    public void Only_edit_tools_with_a_file_are_recorded()
    {
        var (store, preview) = TestServices.Changes();
        store.OnEvent(new AgentEvent("pane", "PostToolUse", "s1", "Bash", null, null), _settings);
        Assert.Empty(preview.List("pane"));
    }

    // ---- Files changed by shell commands ----

    private static AgentEvent Shell(string hookEvent, string cwd, string tool = "PowerShell") =>
        new("pane", hookEvent, "s1", tool, null, null, null, cwd);

    [Fact]
    public void A_file_a_shell_command_makes_next_to_a_listed_file_is_listed_as_new()
    {
        // As in the bug report: Claude writes test.ps1, then makes test_funny.ps1 from it with one PowerShell
        // command, while working in another folder.
        var (store, preview) = TestServices.Changes();
        var listed = Write(@"temp\test.ps1", "Write-Host hi\n");
        Edit(store, listed, "Write-Host hello\n", "Write");
        var elsewhere = Directory.CreateDirectory(Path.Combine(_dir, "home")).FullName;

        store.OnEvent(Shell("PreToolUse", elsewhere), _settings);
        var made = Path.Combine(Path.GetDirectoryName(listed)!, "test_funny.ps1");
        File.WriteAllText(made, "Write-Host funny\n");
        File.WriteAllText(listed, "Write-Host hello again\n");
        store.OnEvent(Shell("PostToolUse", elsewhere), _settings);

        var items = preview.List("pane").ToDictionary(i => Path.GetFileName(i.Path));
        Assert.Equal(("created", "PowerShell"), (items["test_funny.ps1"].Kind, items["test_funny.ps1"].Tool));
        Assert.Equal(2, items["test.ps1"].Edits);
        // The listed file's change is against Termilly's copy from Claude's write, not against git.
        Assert.Equal("Write-Host hello\n", preview.Get("pane", listed, "last", _settings).Before);
        Assert.Equal("Write-Host funny\n", preview.Get("pane", made, "session", _settings).After);
    }

    [Fact]
    public void Folders_a_command_names_are_watched_even_with_an_empty_list_and_claude_elsewhere()
    {
        // As in the second bug report: the list is empty, Claude works from a folder that isn't watched (a drive's
        // root here, the user's profile there), and its PowerShell command edits d:\temp\test.ps1 in place.
        var (store, preview) = TestServices.Changes();
        var temp = Directory.CreateDirectory(Path.Combine(_dir, "temp")).FullName;
        var script = Path.Combine(temp, "test.ps1");
        File.WriteAllText(script, "$a = 1\n");
        var named = new AgentEvent("pane", "PreToolUse", "s1", "PowerShell", null, null, null, @"C:\", [temp]);

        store.OnEvent(named, _settings);
        File.WriteAllText(script, "$apple = 1\n");
        File.WriteAllText(Path.Combine(temp, "test_funny.ps1"), "$banana = 1\n");
        store.OnEvent(named with { Event = "PostToolUse" }, _settings);

        var items = preview.List("pane").ToDictionary(i => Path.GetFileName(i.Path));
        Assert.Equal(("modified", "created"), (items["test.ps1"].Kind, items["test_funny.ps1"].Kind));
        // The copy taken before the command is what test.ps1 is compared with (no git here).
        var view = preview.Get("pane", script, "session", _settings);
        Assert.Equal(("$a = 1\n", "$apple = 1\n", "snapshot"), (view.Before, view.After, view.Source));
        Assert.Equal((1, 1), (items["test.ps1"].Added, items["test.ps1"].Removed));
    }

    [Fact]
    public void A_refactor_by_command_deep_in_a_project_is_listed_against_git()
    {
        var repo = Repo();
        var deep = Directory.CreateDirectory(Path.Combine(repo, "src", "api")).FullName;
        var handler = Path.Combine(deep, "handler.ts");
        File.WriteAllText(handler, "export const oldName = 1;\n");
        TestServices.Git.Text(repo, "add", ".");
        TestServices.Git.Text(repo, "commit", "-q", "-m", "handler");
        var (store, preview) = TestServices.Changes();
        var command = Shell("PreToolUse", repo, "Bash");

        store.OnEvent(command, _settings);
        // sed -i writes a temporary file and renames it over the original.
        var temp = Path.Combine(deep, "sedX1y2Z3");
        File.WriteAllText(temp, "export const newName = 1;\n");
        File.Move(temp, handler, overwrite: true);
        File.WriteAllText(Path.Combine(deep, "added.ts"), "export const extra = 2;\n");
        store.OnEvent(command with { Event = "PostToolUse" }, _settings);

        var items = preview.List("pane").ToDictionary(i => Path.GetFileName(i.Path));
        Assert.Equal(["added.ts", "handler.ts"], items.Keys.Order());
        Assert.Equal(("modified", 1, 1), (items["handler.ts"].Kind, items["handler.ts"].Added, items["handler.ts"].Removed));
        Assert.Equal("created", items["added.ts"].Kind);
        Assert.Equal("export const oldName = 1;\n", preview.Get("pane", handler, "session", _settings).Before);
    }

    [Fact]
    public void A_command_that_writes_many_files_lists_at_most_the_limit()
    {
        var (store, preview) = TestServices.Changes();
        var work = Directory.CreateDirectory(Path.Combine(_dir, "gen")).FullName;

        store.OnEvent(Shell("PreToolUse", work, "Bash"), _settings);
        for (var i = 0; i < ChangeStore.MaxShellFiles + 25; i++)
        {
            File.WriteAllText(Path.Combine(work, $"file{i}.txt"), $"{i}\n");
        }
        store.OnEvent(Shell("PostToolUse", work, "Bash"), _settings);

        Assert.Equal(ChangeStore.MaxShellFiles, preview.List("pane").Count);
    }

    [Fact]
    public void Files_in_folders_a_command_makes_are_new_and_compare_with_that_next_time()
    {
        // As in the bug report: Claude works from a folder that isn't watched (a drive's root here, the user's
        // profile there) and one command makes a folder, its subfolders and files in them; no git anywhere.
        var (store, preview) = TestServices.Changes();
        var proj = Path.Combine(_dir, "proj");
        var command = new AgentEvent("pane", "PreToolUse", "s1", "PowerShell", null, null, null, @"C:\", [Path.Combine(proj, "sub")]);
        var files = Enumerable.Range(1, 3).Select(i => Path.Combine(proj, $"sub{i}", $"file{i}.txt")).ToList();

        store.OnEvent(command, _settings);
        foreach (var file in files)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, "one\n");
        }
        store.OnEvent(command with { Event = "PostToolUse" }, _settings);

        var items = preview.List("pane");
        Assert.Equal(files.Order(StringComparer.OrdinalIgnoreCase), items.Select(i => i.Path).Order(StringComparer.OrdinalIgnoreCase));
        Assert.All(items, i => Assert.Equal(("created", 1), (i.Kind, i.Added)));

        // The next command appends to them: compared with what the first one made.
        store.OnEvent(command, _settings);
        foreach (var file in files)
        {
            File.AppendAllText(file, "two\n");
        }
        store.OnEvent(command with { Event = "PostToolUse" }, _settings);

        var view = preview.Get("pane", files[0], "last", _settings);
        Assert.Equal(("one\n", "one\ntwo\n", 1, 0), (view.Before, view.After, view.Added, view.Removed));
    }

    [Fact]
    public void A_file_deep_in_claudes_folder_is_compared_with_a_copy_taken_before_the_command()
    {
        // Outside git, a file in a subfolder has nothing else to be compared with.
        var (store, preview) = TestServices.Changes();
        var work = Directory.CreateDirectory(Path.Combine(_dir, "work")).FullName;
        var deep = Write(@"work\a\b\deep.txt", "x\n");

        store.OnEvent(Shell("PreToolUse", work, "Bash"), _settings);
        File.AppendAllText(deep, "y\n");
        store.OnEvent(Shell("PostToolUse", work, "Bash"), _settings);

        var view = preview.Get("pane", deep, "session", _settings);
        Assert.Equal(("x\n", "x\ny\n", "snapshot", 1, "modified"), (view.Before, view.After, view.Source, view.Added, view.Kind));
    }

    [Fact]
    public void A_terminal_keeps_the_newest_files_up_to_the_limit()
    {
        var (store, preview) = TestServices.Changes();
        var paths = Enumerable.Range(0, ChangeStore.MaxFilesPerPane + 5).Select(i => Write($@"many\f{i}.txt", "a\n")).ToList();
        foreach (var path in paths)
        {
            Edit(store, path, "b\n");
        }

        var listed = preview.List("pane");
        Assert.Equal(ChangeStore.MaxFilesPerPane, listed.Count);
        Assert.DoesNotContain(listed, i => i.Path == paths[0]); // the oldest went
        Assert.Contains(listed, i => i.Path == paths[^1]);
    }

    [Fact]
    public void Claudes_own_folder_is_watched_and_noise_is_left_out()
    {
        var (store, preview) = TestServices.Changes();
        var work = Directory.CreateDirectory(Path.Combine(_dir, "work")).FullName;
        var same = Write(@"work\same.txt", "x");
        Edit(store, same, "y", "Write"); // on the list, with a copy

        store.OnEvent(Shell("PreToolUse", work, "Bash"), _settings);
        File.WriteAllText(Path.Combine(work, "notes.md"), "# notes\n");
        File.WriteAllText(Path.Combine(work, "scratch.tmp"), "temp");
        File.SetLastWriteTimeUtc(same, DateTime.UtcNow.AddMinutes(1)); // touched, but the same as Termilly's copy
        store.OnEvent(Shell("PostToolUse", work, "Bash"), _settings);

        var items = preview.List("pane").ToDictionary(i => Path.GetFileName(i.Path));
        Assert.Equal(["notes.md", "same.txt"], items.Keys.Order());
        Assert.Equal(1, items["same.txt"].Edits); // not counted again
    }

    [Fact]
    public void Shell_commands_are_not_watched_when_turned_off_or_after_the_turn_ends()
    {
        var (store, preview) = TestServices.Changes();
        var work = Directory.CreateDirectory(Path.Combine(_dir, "work")).FullName;
        var off = _settings with { Changes = _settings.Changes with { ShellFiles = false } };
        store.OnEvent(Shell("PreToolUse", work), off);
        File.WriteAllText(Path.Combine(work, "a.txt"), "a");
        store.OnEvent(Shell("PostToolUse", work), off);
        Assert.Empty(preview.List("pane"));

        // A command that was denied never gets its PostToolUse; the turn's end stops the watch.
        store.OnEvent(Shell("PreToolUse", work), _settings);
        store.OnEvent(new AgentEvent("pane", "Stop", "s1", null, null, null), _settings);
        File.WriteAllText(Path.Combine(work, "b.txt"), "b");
        store.OnEvent(Shell("PostToolUse", work), _settings);
        Assert.Empty(preview.List("pane"));
    }

    // ---- Full edit mode ----

    [Fact]
    public void Full_mode_asks_for_the_edit_and_rebuilds_the_file_from_it()
    {
        var (store, preview) = TestServices.Changes();
        var full = _settings with { Changes = _settings.Changes with { Source = "full" } };
        var path = Write("a.cs", "int a = 1;\nint b = 2;\n");

        Assert.Equal(HookReply.SendEdit, Edit(store, path, "int a = 1;\nint b = 3;\n", settings: full));
        store.OnEdit(new EditContent("pane", "s1", "Edit", path, _dir, [new EditReplace("b = 2", "b = 42", false)],
            null, null, "int a = 1;\nint b = 2;\n", false), full);

        var view = preview.Get("pane", path, "session", full);
        Assert.Equal(("edit", "int a = 1;\nint b = 42;\n"), (view.Source, view.After));
        Assert.Equal("The file has changed since Claude's last edit.", view.Note); // the disk has b = 3
    }

    [Fact]
    public void Full_mode_falls_back_to_the_disk_when_the_edit_doesnt_apply()
    {
        var (store, preview) = TestServices.Changes();
        var full = _settings with { Changes = _settings.Changes with { Source = "full" } };
        var path = Write("a.cs", "x\n");
        Edit(store, path, "y\n", settings: full);
        store.OnEdit(new EditContent("pane", "s1", "Edit", path, _dir, [new EditReplace("not there", "z", false)],
            null, null, null, false), full);

        var view = preview.Get("pane", path, "session", full);
        Assert.Equal(("snapshot", "y\n"), (view.Source, view.After));
        Assert.StartsWith("Showing the file as it is on disk", view.Note);
    }

    [Fact]
    public void Edits_replay_in_order_with_replace_all() =>
        Assert.Equal("1 X X 3", EditReplay.Rebuild(new EditContent("p", null, "MultiEdit", "f", null,
            [new EditReplace("a", "X", true), new EditReplace("2", "3", false)], null, null, null, false), "1 a a 2"));

    // ---- Paths ----

    [Theory]
    [InlineData("/c/Users/me/a.ts", null, @"C:\Users\me\a.ts")]
    [InlineData("C:/Users/me/a.ts", null, @"C:\Users\me\a.ts")]
    [InlineData("src/a.ts", "C:/p", @"C:\p\src\a.ts")]
    [InlineData("../a.ts", @"C:\p\src", @"C:\p\a.ts")]
    [InlineData("/home/me/a.ts", null, null)]
    [InlineData("src/a.ts", null, null)]
    public void Paths_become_windows_paths(string path, string? cwd, string? expected) =>
        Assert.Equal(expected, ChangePaths.Normalize(path, cwd));

    [Theory]
    [InlineData("src/a.ts:12:4", "src/a.ts", 12)]
    [InlineData("(src/a.ts)", "src/a.ts", null)]
    [InlineData("\"C:\\p\\a.ts\",", "C:\\p\\a.ts", null)]
    public void Printed_paths_lose_their_punctuation_and_keep_the_line(string text, string path, int? line) =>
        Assert.Equal(new PrintedPath(path, line), ChangePaths.Clean(text));

    [Fact]
    public void Clicked_paths_resolve_to_changed_files_first_then_the_folders()
    {
        var (store, preview) = TestServices.Changes();
        var changed = Write("src/deep/a.ts", "1");
        var other = Write("docs/b.md", "1");
        Edit(store, changed, "2");

        Assert.Equal(changed, preview.Resolve("pane", "deep/a.ts", remote: false).Path);
        Assert.Equal(other, preview.Resolve("pane", "docs/b.md:3", remote: false, _dir).Path);
        Assert.Equal(3, preview.Resolve("pane", "docs/b.md:3", remote: false, _dir).Line);
        Assert.NotNull(preview.Resolve("pane", "nope/c.ts", remote: false, _dir).Error);
        Assert.Contains("isn't on this PC", preview.Resolve("pane", "/home/me/x.ts", remote: false).Error);
        Assert.Contains("isn't on this PC", preview.Resolve("other", "docs/b.md", remote: true, _dir).Error);
    }

    // ---- Git ----

    private string Repo()
    {
        var repo = Directory.CreateDirectory(Path.Combine(_dir, "repo")).FullName;
        TestServices.Git.Text(repo, "init", "-q", "-b", "main");
        TestServices.Git.Text(repo, "config", "user.email", "test@example.com");
        TestServices.Git.Text(repo, "config", "user.name", "Test");
        TestServices.Git.Text(repo, "config", "core.autocrlf", "false");
        File.WriteAllText(Path.Combine(repo, "a.txt"), "committed\n");
        TestServices.Git.Text(repo, "add", ".");
        TestServices.Git.Text(repo, "commit", "-q", "-m", "first");
        return repo;
    }

    [Fact]
    public void Git_mode_compares_with_the_last_commit_keeping_the_last_newline()
    {
        var repo = Repo();
        var path = Path.Combine(repo, "a.txt");
        var git = _settings with { Changes = _settings.Changes with { Source = "git" } };
        var (store, preview) = TestServices.Changes();
        Assert.Equal(HookReply.Ok, Edit(store, path, "changed\n", settings: git));

        var view = preview.Get("pane", path, "session", git);
        Assert.Equal(("git", "committed\n", "changed\n"), (view.Source, view.Before, view.After));
        Assert.Equal("modified", preview.List("pane").Single().Kind);
    }

    [Fact]
    public void Untracked_files_are_new_in_git_mode_and_files_outside_git_are_shown_as_they_are()
    {
        var repo = Repo();
        var untracked = Path.Combine(repo, "b.txt");
        File.WriteAllText(untracked, "fresh\n");
        var (store, preview) = TestServices.Changes();

        var view = preview.Get("pane", untracked, "session", _settings);
        Assert.Equal(("created", null, "fresh\n"), (view.Kind, view.Before, view.After));

        var outside = Write("plain.txt", "text\n");
        var alone = preview.Get("pane", outside, "session", _settings);
        Assert.Equal(("text\n", "text\n"), (alone.Before, alone.After));
        Assert.StartsWith("Not in a git repository", alone.Note);
    }

    [Fact]
    public void A_missing_file_without_history_is_an_error()
    {
        var view = TestServices.Changes().Preview.Get("pane", Path.Combine(_dir, "gone.txt"), "session", _settings);
        Assert.Equal("File not found.", view.Error);
    }

    // ---- Searching the changed files (the Git window) ----

    [Fact]
    public void The_search_finds_changed_files_by_path_and_by_their_lines_now()
    {
        var (store, preview) = TestServices.Changes();
        var api = Write("src/api.ts", "start\n");
        var readme = Write("readme.md", "start\n");
        Edit(store, api, "const token = 1;\nfetch(token);\nend\r\n");
        Edit(store, readme, "about the API\n");

        var hits = preview.Search("pane", "TOKEN", _settings);
        Assert.Equal([(api, 1, "const token = 1;"), (api, 2, "fetch(token);")], hits.Select(h => (h.Path, h.Line, h.Text)));

        var byPath = preview.Search("pane", "api", _settings);
        Assert.Contains(byPath, h => h.Path == api && h.Line == 0 && h.Display == @"src\api.ts");
        Assert.Contains(byPath, h => h.Path == readme && h.Line == 1);
        Assert.Empty(preview.Search("pane", " ", _settings));
        Assert.Empty(preview.Search("other-pane", "api", _settings));
    }

    [Fact]
    public void The_search_takes_a_few_lines_of_each_file_and_cuts_long_ones()
    {
        var item = new ChangeItem("f", "f", false, "Edit", DateTime.UtcNow, 1, "modified", 0, 0);
        var text = string.Join('\n', Enumerable.Repeat("hit", ChangeSearch.LinesPerFile + 3)) + "\n" + new string('x', 400) + "hit";
        Blob Read(string path, long max) => Blob.From(Encoding.UTF8.GetBytes(text), max);

        var hits = ChangeSearch.Search([item], "HIT", 1 << 20, Read);
        Assert.Equal(ChangeSearch.LinesPerFile, hits.Count);

        var only = ChangeSearch.Search([item], "xhit", 1 << 20, Read).Single();
        Assert.Equal(ChangeSearch.MaxLineChars, only.Text!.Length);
        Assert.Equal(ChangeSearch.LinesPerFile + 4, only.Line);
    }

    // ---- Settings ----

    [Fact]
    public void Change_preview_settings_fall_back_to_their_defaults() =>
        Assert.Equal(new ChangeSettings(),
            new ChangeSettings { Placement = "window", Source = "x", View = "y", Compare = "z", Keep = "q", Context = 7, MaxFileKb = 1, Layout = "w" }.Normalize());
}
