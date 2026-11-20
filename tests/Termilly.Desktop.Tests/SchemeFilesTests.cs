using System.IO;
using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>Reading colour scheme files and folders for the Import dialog (Features/SchemeFiles.cs).</summary>
public sealed class SchemeFilesTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public SchemeFilesTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Write(string relative, string text)
    {
        var path = Path.Combine(_dir, relative);
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, text);
        return path;
    }

    [Fact]
    public async Task A_folder_gives_its_files_and_its_folders_named_by_their_place_in_it()
    {
        Write("Dracula.conf", "background #282a36");
        Write(Path.Combine("kitty", "Nord.conf"), "background #2e3440");
        var read = await SchemeFileHandler.ReadAllAsync("r1", SchemeFileHandler.FilesIn(_dir), _dir);
        Assert.Equal(["Dracula.conf", Path.Combine("kitty", "Nord.conf")], read.Files!.Select(f => f.Name).Order());
        Assert.Equal(0, read.Skipped);
    }

    [Fact]
    public async Task Files_picked_are_named_by_their_file_name_and_a_byte_order_mark_goes()
    {
        var path = Path.Combine(_dir, "bom.json");
        File.WriteAllText(path, "{}", new System.Text.UTF8Encoding(encoderShouldEmitUTF8Identifier: true));
        var read = await SchemeFileHandler.ReadAllAsync(null, [path], root: null);
        Assert.Equal("bom.json", read.Files![0].Name);
        Assert.Equal("{}", read.Files[0].Text);
    }

    [Fact]
    public async Task A_file_too_big_or_gone_is_left_out_and_counted()
    {
        var big = Write("big.json", new string('x', CustomThemeLimits.MaxFileBytes + 1));
        var fine = Write("fine.conf", "background #000000");
        var read = await SchemeFileHandler.ReadAllAsync(null, [big, Path.Combine(_dir, "gone.conf"), fine], root: null);
        Assert.Equal(["fine.conf"], read.Files!.Select(f => f.Name));
        Assert.Equal(2, read.Skipped);
    }

    [Fact]
    public void A_folder_is_read_only_a_few_levels_down()
    {
        var deep = string.Join(Path.DirectorySeparatorChar, Enumerable.Repeat("d", CustomThemeLimits.FolderDepth + 2));
        Write(Path.Combine(deep, "too-deep.conf"), "x");
        Write("top.conf", "x");
        Assert.Equal(["top.conf"], SchemeFileHandler.FilesIn(_dir).Select(Path.GetFileName));
    }
}
