using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The PATH agents are looked for on (Linux and macOS): this process's, the login shell's, the installers' folders.</summary>
public class LoginShellPathTests
{
    [Fact]
    public void Path_is_read_from_what_env_printed_after_anything_a_login_file_said()
    {
        Assert.Equal("/a:/b", LoginShellPath.PathIn("Welcome back\nHOME=/home/u\nPATH=/a:/b\nSHELL=/bin/bash\n"));
        Assert.Equal("/new", LoginShellPath.PathIn("PATH=/old\r\nMYPATH=/no\r\nPATH=/new\r\n"));
        Assert.Null(LoginShellPath.PathIn("HOME=/home/u\n"));
    }

    [Fact]
    public void Folders_come_in_order_each_once_with_the_installers_last()
    {
        var sep = Path.PathSeparator;
        var combined = LoginShellPath.Combine($"/usr/bin{sep}/bin", $"/home/u/.local/bin{sep}/usr/bin", "/home/u").Split(sep);
        Assert.Equal(["/usr/bin", "/bin", "/home/u/.local/bin"], combined.Take(3));
        Assert.Single(combined, folder => folder == "/usr/bin");
        Assert.Contains("/opt/homebrew/bin", combined);
        Assert.Contains(Path.Combine("/home/u", ".claude/local"), combined);
    }

    [Fact]
    public void Without_a_login_shells_answer_this_process_s_folders_still_lead()
    {
        var combined = LoginShellPath.Combine("/usr/bin", null, "/home/u").Split(Path.PathSeparator);
        Assert.Equal("/usr/bin", combined[0]);
        Assert.Contains(Path.Combine("/home/u", ".local/bin"), combined);
    }

    [Fact]
    public void An_agent_in_the_users_own_folder_is_found_though_this_process_s_path_lacks_it()
    {
        if (OperatingSystem.IsWindows())
        {
            return; // Windows gives every program the user's PATH
        }
        var home = Directory.CreateTempSubdirectory("termilly-home").FullName;
        try
        {
            var bin = Directory.CreateDirectory(Path.Combine(home, ".local/bin")).FullName;
            var claude = Path.Combine(bin, "claude");
            File.WriteAllText(claude, "#!/bin/sh\n");
            File.SetUnixFileMode(claude, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            Assert.Equal(claude, SessionProfiles.FindAgent("claude", LoginShellPath.Combine("/usr/bin:/bin", null, home)));
            Assert.Null(SessionProfiles.FindAgent("claude", "/usr/bin:/bin"));
        }
        finally
        {
            Directory.Delete(home, recursive: true);
        }
    }
}
