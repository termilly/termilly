using System.IO;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Running programs to their end (ProcessRunner): their output, their errors, and their limits.</summary>
public sealed class ProcessRunnerTests
{
    private static readonly ProcessRunner Runner = new();

    [Fact]
    public void A_program_that_succeeds_gives_its_output()
    {
        var result = Runner.Run(new ProcessRequest("git", ["--version"]));

        Assert.True(result.Succeeded);
        Assert.StartsWith("git version", result.Text);
        Assert.False(result.Truncated);
    }

    [Fact]
    public void A_program_that_fails_is_a_result_with_its_error_not_an_exception()
    {
        var result = Runner.Run(new ProcessRequest("git", ["no-such-command-xyz"]));

        Assert.False(result.Succeeded);
        Assert.Contains("no-such-command-xyz", result.FirstErrorLine);
    }

    [Fact]
    public void A_missing_program_says_so()
    {
        var e = Assert.Throws<ProgramMissingException>(() => Runner.Run(new ProcessRequest("termilly-no-such-program", [])));

        Assert.Equal("termilly-no-such-program", e.Program);
        Assert.IsAssignableFrom<IOException>(e);
    }

    [Fact]
    public void A_program_past_its_time_is_ended()
    {
        var started = DateTime.UtcNow;

        Assert.Throws<ProcessTimeoutException>(() =>
            Runner.Run(new ProcessRequest("ping", ["-n", "30", "127.0.0.1"]) { Timeout = TimeSpan.FromMilliseconds(300) }));
        Assert.True(DateTime.UtcNow - started < TimeSpan.FromSeconds(10));
    }

    [Fact]
    public void Output_past_the_limit_is_cut_off_and_said_to_be()
    {
        var result = Runner.Run(new ProcessRequest("git", ["help", "-a"]) { MaxOutputBytes = 100 });

        Assert.True(result.Truncated);
        Assert.True(result.Output.Length <= 100);
    }

    [Fact]
    public void Its_folder_and_variables_are_the_ones_asked_for()
    {
        var folder = Path.GetTempPath();
        var result = Runner.Run(new ProcessRequest("cmd.exe", ["/c", "cd & echo %TERMILLY_TEST_VALUE%"])
        {
            WorkingDirectory = folder,
            Environment = new Dictionary<string, string> { ["TERMILLY_TEST_VALUE"] = "42" },
        });

        Assert.Equal([Path.TrimEndingDirectorySeparator(folder), "42"], result.Text.Split("\r\n", StringSplitOptions.RemoveEmptyEntries));
    }
}
