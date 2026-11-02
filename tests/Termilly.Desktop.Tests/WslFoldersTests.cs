namespace Termilly.Desktop.Tests;

/// <summary>Where a WSL terminal starts (WslFolders.cs): a Linux folder goes to wsl.exe as --cd.</summary>
public sealed class WslFoldersTests
{
    [Theory]
    [InlineData("/home/me/x", "/home/me/x")]
    [InlineData(@"\\wsl.localhost\Ubuntu\home\me\my dir", "/home/me/my dir")]
    [InlineData(@"\\wsl$\Ubuntu-24.04\etc\", "/etc")]
    [InlineData(@"\\wsl.localhost\Ubuntu", "/")]
    [InlineData(@"C:\Users\me", null)]
    [InlineData(@"\\server\share\x", null)]
    [InlineData(null, null)]
    public void A_start_folder_in_WSL_is_its_Linux_folder(string? folder, string? linux) =>
        Assert.Equal(linux, WslFolders.LinuxFolder(folder));

    [Fact]
    public void The_folder_replaces_the_profiles_cd_or_is_added()
    {
        // No distribution named: the default one, which wsl.exe checks itself.
        Assert.Equal("wsl.exe --cd \"/home/me/my dir\"", WslFolders.StartingIn("wsl.exe --cd ~", "/home/me/my dir"));
        Assert.Equal("wsl.exe --cd \"/srv\"", WslFolders.StartingIn("wsl.exe", "/srv"));
        Assert.Equal("wsl.exe --cd \"/srv\" -e bash", WslFolders.StartingIn("wsl.exe --cd \"/old place\" -e bash", "/srv"));
    }

    [Fact]
    public void A_folder_that_is_gone_or_cant_be_passed_leaves_the_command_as_it_is()
    {
        Assert.Equal("wsl.exe -d NoSuchDistribution --cd ~", WslFolders.StartingIn("wsl.exe -d NoSuchDistribution --cd ~", "/home/me"));
        Assert.Equal("wsl.exe --cd ~", WslFolders.StartingIn("wsl.exe --cd ~", "/home/\"odd\""));
    }
}
