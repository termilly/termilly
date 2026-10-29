using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>The Files panel's search (FileSearch.cs): names matched, a folder searched here, and a server's answer.</summary>
public sealed class FileSearchTests : IDisposable
{
    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-search-").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    [Theory]
    [InlineData("deploy.ps1", ".ps1", true)]
    [InlineData("Deploy.PS1", ".ps1", true)]
    [InlineData("deploy.psm1", ".ps1", false)]
    [InlineData("deploy.ps1", "*.ps1", true)]
    [InlineData("deploy.ps1.bak", "*.ps1", false)]
    [InlineData("run1.sh", "run?.sh", true)]
    public void A_name_matches_when_it_holds_the_text_or_fits_a_pattern_with_stars(string name, string text, bool matches) =>
        Assert.Equal(matches, FileSearch.Matches(name, text));

    [Fact]
    public void Here_it_finds_names_in_every_folder_down_with_the_folder_each_is_in()
    {
        Directory.CreateDirectory(Path.Combine(_dir, "a", "b"));
        File.WriteAllText(Path.Combine(_dir, "top.ps1"), "x");
        File.WriteAllText(Path.Combine(_dir, "a", "b", "deep.ps1"), "xyz");
        File.WriteAllText(Path.Combine(_dir, "a", "other.txt"), "");
        var found = new List<FoundEntry>();

        var stopped = FileSearch.Here(_dir, ".ps1", found.AddRange, CancellationToken.None);

        Assert.False(stopped);
        Assert.Equal(
            [(_dir, "top.ps1", 1L), (Path.Combine(_dir, "a", "b"), "deep.ps1", 3L)],
            found.Select(f => (f.Dir, f.Entry.Name, f.Entry.Size)).OrderBy(f => f.Item1.Length));
    }

    [Fact]
    public void Here_it_stops_at_the_most_it_finds()
    {
        for (var i = 0; i <= FileSearch.Most; i++)
        {
            File.WriteAllText(Path.Combine(_dir, $"f{i}.log"), "");
        }
        var found = new List<FoundEntry>();

        var stopped = FileSearch.Here(_dir, ".log", found.AddRange, CancellationToken.None);

        Assert.True(stopped);
        Assert.Equal(FileSearch.Most, found.Count);
    }

    [Fact]
    public void A_servers_answer_gives_each_find_its_folder_type_and_size()
    {
        var output = "/home/al\nf\t120\t2026-10-29 10:15\t/home/al/x/run.ps1\nd\t4096\t2026-10-28 09:00\t/home/al/ps1-tools\nf\t0\t\t/top.ps1\n";

        var (found, stopped) = FileSearch.Parse(output, "~");

        Assert.False(stopped);
        Assert.Equal(
            [("/home/al/x", "run.ps1", false, 120L), ("/home/al", "ps1-tools", true, 0L), ("/", "top.ps1", false, 0L)],
            found.Select(f => (f.Dir, f.Entry.Name, f.Entry.IsDirectory, f.Entry.Size)));
    }

    [Fact]
    public void A_server_folder_that_cant_be_read_says_so() =>
        Assert.Throws<IOException>(() => FileSearch.Parse("!\n", "/root"));
}
