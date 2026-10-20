using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class OpenFolderTests
{
    private static readonly string Temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\');

    [Fact]
    public void Open_names_the_folder_explorer_passes() =>
        Assert.Equal(Temp, OpenFolder.Argument(["--open", Temp]));

    [Fact]
    public void A_lone_folder_argument_works_too() =>
        Assert.Equal(Temp, OpenFolder.Argument([Temp]));

    [Fact]
    public void A_drive_comes_as_its_root_even_with_explorers_stray_quote() =>
        Assert.Equal(@"C:\", OpenFolder.Argument(["--open", "C:\""]));

    [Theory]
    [InlineData]
    [InlineData("--open")]
    [InlineData("--open", @"C:\no\such\folder\anywhere")]
    [InlineData("--something-else")]
    public void Anything_else_is_a_normal_start(params string[] args) =>
        Assert.Null(OpenFolder.Argument(args));

    [Fact]
    public async Task The_second_termilly_for_a_data_folder_hands_over_to_the_first()
    {
        var data = Path.Combine(Temp, "termilly-instance-" + Guid.NewGuid().ToString("N"));
        using var first = OpenFolder.ClaimInstance(out var isFirst, data);
        // On another thread, as a second process would: a mutex belongs to the thread that took it.
        var second = await Task.Run(() =>
        {
            using var mutex = OpenFolder.ClaimInstance(out var secondIsFirst, data);
            return secondIsFirst;
        });
        var other = await Task.Run(() =>
        {
            using var mutex = OpenFolder.ClaimInstance(out var otherIsFirst, data + "-other");
            return otherIsFirst;
        });
        Assert.Equal((true, false, true), (isFirst, second, other)); // another data folder runs its own Termilly
    }
}
