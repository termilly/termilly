using System.IO;
using System.IO.Compression;
using Termilly.Desktop.Phone;

namespace Termilly.Desktop.Tests;

/// <summary>Unpacking an item another computer copied here (Phone/ItemUnzip.cs): within its room, inside its folder.</summary>
public sealed class ItemUnzipTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-unzip-test-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private string Zip(params (string Name, string Text)[] entries)
    {
        var zip = Path.Combine(_dir, $"{Guid.NewGuid():N}.zip");
        using var archive = ZipFile.Open(zip, ZipArchiveMode.Create);
        foreach (var (name, text) in entries)
        {
            var entry = archive.CreateEntry(name);
            if (text.Length > 0)
            {
                using var writer = new StreamWriter(entry.Open());
                writer.Write(text);
            }
        }
        return zip;
    }

    private string Out => Path.Combine(_dir, "out");

    [Fact]
    public void An_item_unpacks_with_its_folders_and_files()
    {
        ItemUnzip.Extract(Zip(("item/", ""), ("item/a.txt", "hello"), ("item/sub/b.txt", "there")), Out, 1 << 20);
        Assert.Equal("hello", File.ReadAllText(Path.Combine(Out, "item", "a.txt")));
        Assert.Equal("there", File.ReadAllText(Path.Combine(Out, "item", "sub", "b.txt")));
    }

    [Fact]
    public void A_file_that_would_land_outside_its_folder_is_refused()
    {
        Assert.Throws<IOException>(() => ItemUnzip.Extract(Zip(("../evil.txt", "x")), Out, 1 << 20));
        Assert.False(File.Exists(Path.Combine(_dir, "evil.txt")));
    }

    [Fact]
    public void A_copy_bigger_than_the_room_is_refused_before_anything_is_written()
    {
        Assert.Throws<InvalidDataException>(() => ItemUnzip.Extract(Zip(("item/a.txt", new string('x', 1000))), Out, 999));
        Assert.False(Directory.Exists(Out));
    }

    [Fact]
    public void A_copys_size_is_what_its_files_unpack_to()
    {
        Assert.Equal(8, ItemUnzip.Size(Zip(("item/", ""), ("item/a.txt", "hello"), ("item/b.txt", "abc"))));
    }
}
