using System.Runtime.InteropServices;

namespace Termilly.Desktop.Tests;

/// <summary>The Git window over ssh (GitRunner.cs): what the page sends reaches the server's git as plain words.</summary>
public sealed class SshGitRunnerTests
{
    [DllImport("shell32.dll", EntryPoint = "CommandLineToArgvW", CharSet = CharSet.Unicode)]
    private static extern IntPtr CommandLineToArgv(string commandLine, out int count);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);

    /// <summary>How Windows (and so ssh.exe) splits a command line into arguments.</summary>
    private static string[] Split(string commandLine)
    {
        var argv = CommandLineToArgv("ssh.exe " + commandLine, out var count);
        try
        {
            return Enumerable.Range(1, count - 1).Select(i => Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size))!).ToArray();
        }
        finally
        {
            LocalFree(argv);
        }
    }

    [Fact]
    public void Words_reach_the_server_shell_as_they_are()
    {
        Assert.Equal("'a b'", SshGitRunner.Quote("a b"));
        Assert.Equal(@"'it'\''s'", SshGitRunner.Quote("it's"));
        Assert.Equal("'$(rm -rf ~); `x`'", SshGitRunner.Quote("$(rm -rf ~); `x`"));
    }

    [Theory]
    [InlineData("plain")]
    [InlineData("two words")]
    [InlineData("say \"hi\"")]
    [InlineData(@"C:\dir\")]
    [InlineData(@"a\\""b")]
    [InlineData("git -C '/srv/my repo' log '--format=%H\x1f%s'")]
    public void The_remote_command_is_one_argument_for_ssh(string command) =>
        Assert.Equal([command], Split(SshGitRunner.QuoteArgument(command)));

    [Fact]
    public void Ssh_gets_the_terminals_arguments_and_one_command()
    {
        var runner = new SshGitRunner(TestServices.Runner, "-p 2222 -J bastion deploy@db1", null);
        var args = Split(runner.Arguments(SshGitRunner.GitCommand("/srv/app", ["status", "--porcelain=v2"])));
        Assert.Equal(["-T", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-p", "2222", "-J", "bastion", "deploy@db1"], args[..^1]);
        Assert.StartsWith("LC_ALL=C GIT_PAGER=cat GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 git -C '/srv/app' '--no-optional-locks'", args[^1]);
        Assert.EndsWith("'status' '--porcelain=v2'", args[^1]);

        // A password through the askpass helper: ssh may ask it, so no batch mode.
        var withPassword = new SshGitRunner(TestServices.Runner, "db1", new Dictionary<string, string> { ["SSH_ASKPASS"] = "x" });
        Assert.DoesNotContain("BatchMode", withPassword.Arguments("true"));
    }

    [Fact]
    public void Paths_from_the_page_stay_inside_the_repository()
    {
        var runner = new SshGitRunner(TestServices.Runner, "db1", null);
        Assert.Equal("src/a b.txt", runner.CheckPath("/srv/app", "src/a b.txt"));
        foreach (var bad in new[] { "../etc/passwd", "/etc/passwd", "-c", "a/./b", "a\nb", "C:x" })
        {
            Assert.Throws<ArgumentException>(() => runner.CheckPath("/srv/app", bad));
        }
        Assert.Throws<ArgumentException>(() => runner.CheckRoot("relative/path"));
        Assert.Throws<ArgumentException>(() => runner.CheckRoot("/srv/app\nrm"));
    }
}
