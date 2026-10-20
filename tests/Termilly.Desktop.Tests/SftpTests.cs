namespace Termilly.Desktop.Tests;

public sealed class SftpTests
{
    [Theory]
    [InlineData("ssh.exe user@host", "user@host")]
    [InlineData("ssh.exe -p 2222 -J jump user@host", "-P 2222 -J jump user@host")]
    [InlineData("ssh.exe -i \"C:\\keys\\id-p 1\" user@host", "-i \"C:\\keys\\id-p 1\" user@host")]
    public void Sftp_gets_the_ssh_options_with_a_capital_port_flag(string ssh, string sftp) =>
        Assert.Equal(sftp, Sftp.ArgumentsFor(ssh));

    [Fact]
    public void Commands_that_are_not_ssh_have_no_sftp() =>
        Assert.Null(Sftp.ArgumentsFor("powershell.exe -NoLogo"));

    [Fact]
    public void Paths_are_quoted_for_batch_lines() =>
        Assert.Equal("\"/tmp/a \\\"b\\\" c\\\\d\"", Sftp.Quote("/tmp/a \"b\" c\\d"));

    [Fact]
    public void A_listing_parses_folders_first_and_skips_dot_entries()
    {
        const string output = """
            sftp> pwd
            Remote working directory: /home/alex/work
            sftp> ls -la
            drwxr-xr-x    5 alex     alex         4096 Oct  9 12:00 .
            drwxr-xr-x   20 alex     alex         4096 Oct  1  2025 ..
            -rw-r--r--    1 alex     alex        12345 Oct  9 11:59 notes with spaces.txt
            drwxr-xr-x    2 alex     alex         4096 Sep 30 08:15 logs
            lrwxrwxrwx    1 alex     alex           11 Oct  2 10:00 current -> logs/today
            -rw-******    ? root     root          392 Oct  8 11:46 alternatives.log
            """;

        Assert.Equal("/home/alex/work", Sftp.ParsePwd(output));
        var entries = Sftp.ParseListing(output);
        Assert.Equal(["logs", "alternatives.log", "current", "notes with spaces.txt"], entries.Select(e => e.Name));
        Assert.True(entries[0].IsDirectory);
        Assert.Equal(12345, entries[3].Size);
        Assert.Equal("Oct  9 11:59", entries[3].Modified);
    }

    [Theory]
    [InlineData("/", "a", "/a")]
    [InlineData("/var/log", "syslog", "/var/log/syslog")]
    public void Remote_paths_join_with_slashes(string dir, string name, string joined) =>
        Assert.Equal(joined, Sftp.Join(dir, name));
}
