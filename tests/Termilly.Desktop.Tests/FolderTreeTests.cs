using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>"Copy to"'s folder tree (FolderTree.cs): here, in a folder of the test's own, and a server's answer.</summary>
public sealed class FolderTreeTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-tree-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Fact]
    public void Here_a_folder_lists_only_its_folders_each_saying_whether_it_has_folders()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "src", "app"));
        Directory.CreateDirectory(Path.Combine(_dir, "docs"));
        File.WriteAllText(Path.Combine(_dir, "docs", "readme.md"), "");
        File.WriteAllText(Path.Combine(_dir, "notes.txt"), "");

        var branch = Assert.Single(FolderTree.Here([_dir]));

        Assert.Equal(_dir, branch.Full);
        Assert.Null(branch.Error);
        Assert.Equal([new TreeFolder("docs", false), new TreeFolder("src", true)], branch.Folders);
    }

    [Fact]
    public void Here_a_folder_that_isnt_there_says_so_and_the_others_are_still_listed()
    {
        var gone = Path.Combine(_dir, "gone");

        var branches = FolderTree.Here([gone, _dir]);

        Assert.NotNull(branches[0].Error);
        Assert.Null(branches[0].Full);
        Assert.Equal(_dir, branches[1].Full);
    }

    [Fact]
    public void A_servers_answer_gives_each_folder_its_full_path_and_folders_by_name()
    {
        const string output = "@@0\n/home/alex\n0\tnotes\n1\tDevelopment\n1\t.config\n@@1\n!\n@@2\n/\n1\tusr\n";

        var branches = FolderTree.Parse(output, ["~", "/root", "/"]);

        Assert.Equal("/home/alex", branches[0].Full);
        Assert.Equal([new TreeFolder(".config", true), new TreeFolder("Development", true), new TreeFolder("notes", false)], branches[0].Folders);
        Assert.Equal("~", branches[0].Path);
        Assert.NotNull(branches[1].Error);
        Assert.Equal([new TreeFolder("usr", true)], branches[2].Folders);
    }

    [Fact]
    public void A_name_with_a_tab_in_it_keeps_it()
    {
        var branch = Assert.Single(FolderTree.Parse("@@0\n/x\n0\ta\tb\n", ["/x"]));

        Assert.Equal("a\tb", Assert.Single(branch.Folders).Name);
    }

    [Fact]
    public void With_files_a_servers_answer_lists_everything_and_a_link_to_a_folder_is_a_folder()
    {
        const string output = "@@0\n/srv\ntotal 12\n"
            + "drwxr-xr-x  3 a a 4096 Oct  9 12:00 .\n"
            + "drwxr-xr-x  3 a a 4096 Oct  9 12:00 ..\n"
            + "-rw-r--r--  1 a a   12 Oct  9 12:00 notes.txt\n"
            + "drwxr-xr-x  2 a a 4096 Oct  9 12:00 empty\n"
            + "lrwxrwxrwx  1 a a    4 Oct  9 12:00 www -> /var/www\n"
            + "0\tempty\n1\twww\n";

        var branch = Assert.Single(FolderTree.Parse(output, ["/srv"], files: true));

        Assert.Equal(["empty", "www", "notes.txt"], branch.Entries!.Select(e => e.Name));
        Assert.True(branch.Entries![1].IsDirectory);
        Assert.Equal([new TreeFolder("empty", false), new TreeFolder("www", true)], branch.Folders);
    }

    [Fact]
    public void Here_with_files_a_folder_with_only_files_in_it_has_something_to_open()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "docs"));
        File.WriteAllText(Path.Combine(_dir, "docs", "readme.md"), "");
        File.WriteAllText(Path.Combine(_dir, "notes.txt"), "");

        var branch = Assert.Single(FolderTree.Here([_dir], files: true));

        Assert.Equal([new TreeFolder("docs", true)], branch.Folders);
        Assert.Equal(["docs", "notes.txt"], branch.Entries!.Select(e => e.Name));
    }
}
