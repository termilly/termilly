using Termilly.Desktop;
using Termilly.Pty;

namespace Termilly.Core.Tests;

/// <summary>A schedule's hidden shell on Linux and macOS: the words of a command reach the shell whole, and its exit code comes back.</summary>
public sealed class ScheduleShellTests
{
    private static async Task<ScheduleResult> Run(string command)
    {
        var profile = new SessionProfile("bash", "bash", "", ProfileIcons.Bash, "/bin/bash", ProfileSources.Local);
        var options = new PtyOptions(OneShot.CommandLine(profile, command), ScheduleRunner.Columns, ScheduleRunner.Rows);
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        return await runner.RunAsync(new ScheduleJob("run", options, TimeSpan.FromSeconds(30)));
    }

    [Theory]
    [InlineData("exit 3", 3)]
    [InlineData("true", 0)]
    [InlineData("false", 1)]
    [InlineData("a=1\nb=2\nexit $((a + b))", 3)]
    public async Task ItEndsWithWhatTheCommandEndedWith(string command, int code)
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        Assert.Equal(code, (await Run(command)).ExitCode);
    }

    [Fact]
    public async Task QuotesDollarsAndBackslashesReachTheShellAsWritten()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }
        var result = await Run("""x=world; printf '%s|' "it's" "$x" 'a\b' "$((1 + 1))" """);
        Assert.Contains(@"it's|world|a\b|2|", result.Output);
    }
}
