using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>The Files panel's folders on this machine (LocalFiles.cs), in a folder of the test's own.</summary>
public sealed class LocalFilesTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-files-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string At(string name) => Path.Combine(_dir, name);

    [Fact]
    public void A_listing_has_folders_first_then_files_by_name_with_their_sizes()
    {
        File.WriteAllText(At("b.txt"), "12345");
        File.WriteAllText(At(".env"), "");
        Directory.CreateDirectory(At("src"));

        var (path, entries) = LocalFiles.List(_dir);

        Assert.Equal(_dir, path);
        Assert.Equal(["src", ".env", "b.txt"], entries.Select(e => e.Name));
        Assert.True(entries[0].IsDirectory);
        Assert.Equal(5, entries[2].Size);
    }

    [Fact]
    public void A_folder_that_is_not_there_is_an_error_to_show()
    {
        var error = Assert.Throws<IOException>(() => LocalFiles.List(At("gone")));
        Assert.Contains("isn't there", error.Message);
    }

    [Fact]
    public void Renaming_never_replaces_what_is_already_there()
    {
        File.WriteAllText(At("a.txt"), "a");
        File.WriteAllText(At("b.txt"), "b");

        Assert.Throws<IOException>(() => LocalFiles.Rename(At("a.txt"), At("b.txt")));
        Assert.Equal("b", File.ReadAllText(At("b.txt")));

        LocalFiles.Rename(At("a.txt"), At("c.txt"));
        Assert.Equal("a", File.ReadAllText(At("c.txt")));
    }

    [Fact]
    public void A_file_copied_in_gets_a_free_name_when_its_own_is_taken()
    {
        var source = Directory.CreateDirectory(At("from")).FullName;
        File.WriteAllText(Path.Combine(source, "notes.md"), "new");
        File.WriteAllText(At("notes.md"), "old");

        var copy = LocalFiles.CopyInto(Path.Combine(source, "notes.md"), _dir);

        Assert.Equal(At("notes (1).md"), copy);
        Assert.Equal(("old", "new"), (File.ReadAllText(At("notes.md")), File.ReadAllText(copy)));
    }

    [Fact]
    public void A_new_folder_is_made_once()
    {
        LocalFiles.MakeDirectory(At("logs"));
        Assert.True(Directory.Exists(At("logs")));
        Assert.Throws<IOException>(() => LocalFiles.MakeDirectory(At("logs")));
    }

    [Fact]
    public void A_folder_copied_to_one_of_its_name_merges_into_it_replacing_the_files_both_have()
    {
        var source = Directory.CreateDirectory(At("from/docs/deep")).Parent!.FullName;
        File.WriteAllText(Path.Combine(source, "a.md"), "new a");
        File.WriteAllText(Path.Combine(source, "deep", "b.md"), "new b");
        var target = Directory.CreateDirectory(At("to/docs")).FullName;
        File.WriteAllText(Path.Combine(target, "a.md"), "old a");
        File.WriteAllText(Path.Combine(target, "kept.md"), "kept");

        LocalFiles.CopyTree(source, target);

        Assert.Equal("new a", File.ReadAllText(Path.Combine(target, "a.md")));
        Assert.Equal("new b", File.ReadAllText(Path.Combine(target, "deep", "b.md")));
        Assert.Equal("kept", File.ReadAllText(Path.Combine(target, "kept.md")));
    }

    [Fact]
    public void A_file_copied_replaces_one_there_and_a_folder_never_goes_into_itself()
    {
        File.WriteAllText(At("a.txt"), "new");
        Directory.CreateDirectory(At("to"));
        File.WriteAllText(At("to/a.txt"), "old");

        LocalFiles.CopyTree(At("a.txt"), At("to/a.txt"));

        Assert.Equal("new", File.ReadAllText(At("to/a.txt")));
        var error = Assert.Throws<IOException>(() => LocalFiles.CopyTree(At("to"), At("to/inner")));
        Assert.Contains("into itself", error.Message);
        Assert.False(Directory.Exists(At("to/inner")));
    }

    [Theory]
    [InlineData("/home/a/src/x", "/home/a/src", true)]
    [InlineData("/home/a/src", "/home/a/src/", true)]
    [InlineData("/home/a/srcs", "/home/a/src", false)]
    [InlineData("/home/a", "/home/a/src", false)]
    public void A_path_is_inside_a_folder_only_below_it_not_beside_it(string path, string folder, bool inside) =>
        Assert.Equal(inside, LocalFiles.IsInside(path, folder, '/'));

    [Fact]
    public void A_copy_on_a_server_merges_a_folder_s_contents_and_quotes_every_path()
    {
        var command = FileCopies.CopyCommand("/srv/it's", "/home/a/it's");

        Assert.Equal(
            "if [ -d '/srv/it'\\''s' ]; then mkdir -p '/home/a/it'\\''s' && cp -R '/srv/it'\\''s/.' '/home/a/it'\\''s'; " +
            "else cp -f '/srv/it'\\''s' '/home/a/it'\\''s'; fi", command);
    }

    [Fact]
    public void Folders_uploaded_from_windows_get_the_servers_own_folder_mode_and_no_others_change()
    {
        Assert.Equal(
            "find '/home/a/docs' -type d -perm 0707 -exec chmod \"$(printf %o $((0777 & ~$(umask))))\" {} +",
            FileCopies.FolderModeCommand("/home/a/docs"));
    }
}
