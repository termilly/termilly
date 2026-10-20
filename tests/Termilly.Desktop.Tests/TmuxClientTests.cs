namespace Termilly.Desktop.Tests;

public sealed class TmuxClientTests
{
    [Theory]
    [InlineData("wsl.exe -d Ubuntu -e tmux -C attach -t demo", "wsl.exe", "-d Ubuntu -e tmux -C attach -t demo")]
    [InlineData("\"C:\\Program Files\\Git\\usr\\bin\\ssh.exe\" -T box tmux -C new -A -s main", @"C:\Program Files\Git\usr\bin\ssh.exe", "-T box tmux -C new -A -s main")]
    [InlineData("tmux", "tmux", "")]
    public void A_command_line_splits_into_program_and_arguments(string line, string file, string arguments)
    {
        Assert.Equal(new CommandParts(file, arguments), TmuxClient.Split(line));
    }
}
