using Termilly.Setup;
using Termilly.Setup.Engine;

namespace TermillySetup.Tests;

/// <summary>Setup's options as text (for the elevated copy and the registry), and how a quiet install changes them.</summary>
public class OptionsTests
{
    [Fact]
    public void Options_come_back_from_their_text()
    {
        var options = new SetupOptions
        {
            AllUsers = true, InstallDir = @"D:\Apps\Termilly", StartMenu = false, Desktop = true, ExplorerMenu = false,
            PathCommand = false, AgentIntegration = false, BackgroundAtSignIn = true, PreferIncluded = true, Launch = false,
        };

        var back = SetupOptions.FromArgument(options.ToArgument());

        Assert.Equal(options.ToArgument(), back.ToArgument());
        Assert.True(back.AllUsers);
        Assert.Equal(@"D:\Apps\Termilly", back.InstallDir);
        Assert.False(back.StartMenu);
        Assert.True(back.Desktop);
        Assert.True(back.BackgroundAtSignIn);
    }

    [Fact]
    public void Missing_or_unreadable_options_keep_their_defaults()
    {
        var defaults = new SetupOptions();
        var read = SetupOptions.FromArgument("desktop=maybe;bogus=1;startMenu");

        Assert.False(read.AllUsers);
        Assert.Equal(SetupOptions.DefaultDir(false), read.InstallDir);
        Assert.Equal(defaults.Desktop, read.Desktop);
        Assert.Equal(defaults.StartMenu, read.StartMenu);
        Assert.Equal(defaults.Launch, read.Launch);
    }

    [Fact]
    public void An_all_users_install_without_a_folder_goes_to_Program_Files()
    {
        Assert.Equal(SetupOptions.DefaultDir(true), SetupOptions.FromArgument("allUsers=True").InstallDir);
    }

    [Fact]
    public void Quiet_flags_turn_options_on_and_off()
    {
        var options = Quiet.Apply(new SetupOptions(), Args("--quiet", "--desktop", "--no-start-menu", "--no-explorer", "--no-agent", "--sign-in", "--offline"));

        Assert.True(options.Desktop);
        Assert.False(options.StartMenu);
        Assert.False(options.ExplorerMenu);
        Assert.False(options.AgentIntegration);
        Assert.True(options.BackgroundAtSignIn);
        Assert.True(options.PreferIncluded);
        Assert.True(options.PathCommand);
    }

    [Fact]
    public void Quiet_keeps_what_was_installed_when_no_flag_says_otherwise()
    {
        var installed = new SetupOptions { Desktop = true, PathCommand = false, StartMenu = false };

        var options = Quiet.Apply(installed, Args("--quiet"));

        Assert.True(options.Desktop);
        Assert.False(options.PathCommand);
        Assert.False(options.StartMenu);
    }

    [Fact]
    public void Quiet_path_flags_and_folders()
    {
        Assert.True(Quiet.Apply(new SetupOptions { PathCommand = false }, Args("--path")).PathCommand);
        Assert.False(Quiet.Apply(new SetupOptions(), Args("--path", "--no-path")).PathCommand);

        var allUsers = Quiet.Apply(new SetupOptions(), Args("--all-users"));
        Assert.True(allUsers.AllUsers);
        Assert.Equal(SetupOptions.DefaultDir(true), allUsers.InstallDir);

        var folder = Quiet.Apply(new SetupOptions(), Args("--all-users", "--DIR", @"%SystemDrive%\Tools\Termilly"));
        Assert.Equal(System.Environment.ExpandEnvironmentVariables(@"%SystemDrive%\Tools\Termilly"), folder.InstallDir);
    }

    [Fact]
    public void An_update_installs_into_the_same_folder_and_starts_termilly_again()
    {
        // What Termilly runs for an update of an install for all users (UpdateInstall.cs), as Windows splits it.
        var args = Args(Flags.Quiet, Flags.Start, Flags.AllUsers, Flags.Dir, @"C:\Program Files\Termilly");
        var installed = new SetupOptions { AllUsers = true, InstallDir = @"C:\Program Files\Termilly", Desktop = true };

        var options = Quiet.Apply(installed, args);

        Assert.True(args.Has(Flags.Start));
        Assert.True(options.AllUsers);
        Assert.Equal(@"C:\Program Files\Termilly", options.InstallDir);
        Assert.True(options.Desktop); // the rest stays as it was installed
    }

    [Fact]
    public void Arguments_match_without_regard_to_case_and_read_the_value_after_a_flag()
    {
        var args = Args("--Quiet", "--dir", "C:\\x");

        Assert.True(args.Has("--quiet"));
        Assert.False(args.Has("--uninstall"));
        Assert.Equal("C:\\x", args.Value("--DIR"));
        Assert.Null(Args("--dir").Value("--dir"));
    }

    [Theory]
    [InlineData("1.0.0", "1.0.0", 0)]
    [InlineData("1.0.1", "1.0.0", 1)]
    [InlineData("1.2", "1.10", -1)]
    [InlineData("2", "1.9.9", 1)]
    [InlineData("1.0.x", "1.0.0", 0)]
    public void Versions_compare_part_by_part(string a, string b, int sign)
    {
        Assert.Equal(sign, System.Math.Sign(InstalledTermilly.CompareVersions(a, b)));
    }

    private static Arguments Args(params string[] args) => new(args);
}
