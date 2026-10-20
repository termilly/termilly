using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>Starting Termilly again on Linux (these do nothing on Windows; Termilly.Desktop.Tests has its own).</summary>
public sealed class OpenFolderTests
{
    private static string NewDataFolder() =>
        Path.Combine(Path.GetTempPath(), "termilly-instance-" + Guid.NewGuid().ToString("N"));

    [Fact]
    public void The_second_termilly_for_a_data_folder_hands_over_to_the_first()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var data = NewDataFolder();
        try
        {
            using var first = OpenFolder.ClaimInstance(out var isFirst, data);
            using (OpenFolder.ClaimInstance(out var secondIsFirst, data))
            {
                Assert.False(secondIsFirst);
            }
            using (OpenFolder.ClaimInstance(out var otherIsFirst, data + "-other"))
            {
                Assert.True(otherIsFirst); // a test copy with its own data folder runs alongside
            }
            Assert.True(isFirst);
        }
        finally
        {
            Directory.Delete(data, recursive: true);
            Directory.Delete(data + "-other", recursive: true);
        }
    }

    [Fact]
    public void Once_the_first_has_gone_the_next_one_is_first_again()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var data = NewDataFolder();
        try
        {
            OpenFolder.ClaimInstance(out _, data)!.Dispose();
            using var next = OpenFolder.ClaimInstance(out var isFirst, data);
            Assert.True(isFirst);
        }
        finally
        {
            Directory.Delete(data, recursive: true);
        }
    }

    [Fact]
    public void A_folder_argument_is_a_posix_path_relative_to_where_it_was_started()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var temp = Path.GetFullPath(Path.GetTempPath()).TrimEnd('/');
        Assert.Equal(temp, OpenFolder.Argument([temp]));
        Assert.Equal(temp, OpenFolder.Argument(["--open", temp + "/"]));
        Assert.Equal(Environment.CurrentDirectory, OpenFolder.Argument(["."]));
        Assert.Equal("/", OpenFolder.Argument(["/"]));
        Assert.Null(OpenFolder.Argument(["/no/such/folder/anywhere"]));
    }
}
