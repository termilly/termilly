using System.IO;
using System.Runtime.Versioning;
using Termilly.Linux;

namespace Termilly.Core.Tests;

/// <summary>The Downloads folder a desktop's user-dirs.dirs names, where the Files panel saves downloads.</summary>
[SupportedOSPlatform("linux")] // only parsing text: runs anywhere
public sealed class LinuxDownloadsTests
{
    private const string Home = "/home/me";

    [Fact]
    public void A_folder_in_home_is_found_in_the_desktops_language() =>
        Assert.Equal(Path.Combine(Home, "Téléchargements"),
            LinuxPlatform.DownloadsIn("# comment\nXDG_DESKTOP_DIR=\"$HOME/Bureau\"\nXDG_DOWNLOAD_DIR=\"$HOME/Téléchargements\"\n", Home));

    [Fact]
    public void A_folder_elsewhere_is_taken_as_it_is() =>
        Assert.Equal("/data/downloads", LinuxPlatform.DownloadsIn("XDG_DOWNLOAD_DIR=\"/data/downloads\"", Home));

    [Theory]
    [InlineData("")]
    [InlineData("XDG_DOWNLOAD_DIR=\"$HOME/\"")]
    public void Without_one_it_is_Downloads_in_home(string userDirs) =>
        Assert.Equal(Path.Combine(Home, "Downloads"), LinuxPlatform.DownloadsIn(userDirs, Home));
}
