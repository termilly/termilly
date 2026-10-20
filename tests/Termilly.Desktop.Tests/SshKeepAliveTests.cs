namespace Termilly.Desktop.Tests;

public sealed class SshKeepAliveTests
{
    private static readonly string Ssh = SessionProfiles.SshCommand;

    [Fact]
    public void Ssh_terminals_get_server_keepalives()
    {
        Assert.Equal($"{Ssh} -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -J bastion deploy@db1", SessionLaunch.WithKeepAlive($"{Ssh} -J bastion deploy@db1"));
    }

    [Fact]
    public void Keepalives_already_set_and_other_commands_are_left_alone()
    {
        var own = $"{Ssh} -o ServerAliveInterval=60 host";
        Assert.Equal(own, SessionLaunch.WithKeepAlive(own));
        Assert.Equal("mosh host", SessionLaunch.WithKeepAlive("mosh host"));
    }
}
