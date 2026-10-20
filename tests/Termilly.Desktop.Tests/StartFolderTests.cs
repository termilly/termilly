using System.IO;

namespace Termilly.Desktop.Tests;

/// <summary>Where a terminal starts when the folder it was last in is gone (AppPaths.StartFolder).</summary>
public sealed class StartFolderTests : IDisposable
{
    private readonly string _dir = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), "termilly-start-" + Guid.NewGuid().ToString("N"))).FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static readonly string Home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);

    [Fact]
    public void A_folder_that_is_there_is_used()
    {
        Assert.Equal(new ChosenFolder(_dir, false), AppPaths.StartFolder(_dir, null));
        Assert.Equal(new ChosenFolder(Home, false), AppPaths.StartFolder("%USERPROFILE%", null)); // the home folder isn't "missing"
        Assert.Equal(new ChosenFolder(Home, false), AppPaths.StartFolder(null, _dir));
    }

    [Fact]
    public void A_deleted_folder_gives_way_to_the_next_then_home()
    {
        var gone = Path.Combine(_dir, "deleted");
        Assert.Equal(new ChosenFolder(_dir, true), AppPaths.StartFolder(gone, _dir));
        Assert.Equal(new ChosenFolder(Home, true), AppPaths.StartFolder(gone, Path.Combine(_dir, "also gone")));
        Assert.Equal(new ChosenFolder(Home, true), AppPaths.StartFolder(gone, null));
    }
}
