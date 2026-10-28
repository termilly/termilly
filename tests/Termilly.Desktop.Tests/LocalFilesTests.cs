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
}
