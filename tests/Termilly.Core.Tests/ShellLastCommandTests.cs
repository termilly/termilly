using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The last command of a shell line as its program gets it, which bash -c runs in its own place (exec).</summary>
public sealed class ShellLastCommandTests
{
    [Theory]
    [InlineData("sleep 172", "sleep 172")]
    [InlineData("cd /tmp && sleep 172", "sleep 172")]
    [InlineData("cd /tmp; sleep 173", "sleep 173")]
    [InlineData("cat <<'EOF'\nhi there\nEOF\nsleep 178", "sleep 178")]
    [InlineData("cd /tmp && exec sleep 190", "sleep 190")]
    [InlineData("python3 -c 'import time; time.sleep(60)'", "python3 -c import time; time.sleep(60)")]
    [InlineData("sleep \"197\"", "sleep 197")]
    [InlineData("cd /tmp && ls -la '/tmp' >/dev/null && sleep 198", "sleep 198")]
    [InlineData("FOO=1 BAR=x node server.js > out.log 2>&1", "node server.js")]
    [InlineData("echo a\\ b", "echo a b")]
    [InlineData("cd /tmp &&", null)]
    public void The_last_command_is_the_words_its_program_gets(string commandLine, string? expected)
    {
        Assert.Equal(expected, ShellLastCommand.Of(commandLine));
    }
}
