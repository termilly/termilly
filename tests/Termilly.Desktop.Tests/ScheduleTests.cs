using System.IO;
using System.Text;
using Termilly.Desktop.Features;
using Termilly.Desktop.Security;
using Termilly.Pty;

namespace Termilly.Desktop.Tests;

/// <summary>Schedules' hidden shells: how each kind of shell is asked to run one command, and real runs in a pseudo terminal.</summary>
public sealed class ScheduleTests
{
    private static SessionProfile Profile(string commandLine, string icon, string source = ProfileSources.Local, IReadOnlyDictionary<string, string>? environment = null) =>
        new("id", "name", "", icon, commandLine, source, Environment: environment);

    private static ScheduleJob Job(string command, int seconds = 30) => new(
        Guid.NewGuid().ToString("N"),
        new PtyOptions(OneShot.CommandLine(Profile("cmd.exe", ProfileIcons.Cmd), command), ScheduleRunner.Columns, ScheduleRunner.Rows),
        TimeSpan.FromSeconds(seconds));

    [Fact]
    public void PowerShellGetsItsCommandEncodedAndPassesOnTheExitCode()
    {
        var line = OneShot.CommandLine(Profile("pwsh.exe", ProfileIcons.PowerShell), "echo \"hi\"");
        Assert.StartsWith("pwsh.exe -NoLogo -NonInteractive -EncodedCommand ", line);
        var script = Encoding.Unicode.GetString(Convert.FromBase64String(line.Split(' ')[^1]));
        Assert.StartsWith("echo \"hi\"\n", script);
        Assert.Contains("exit $LASTEXITCODE", script);
    }

    [Fact]
    public void CmdRunsTheLinesOfASnippetOneAfterTheOther()
    {
        Assert.Equal("cmd.exe /s /c \"cd .. & dir\"", OneShot.CommandLine(Profile("cmd.exe", ProfileIcons.Cmd), "cd ..\r\n\r\ndir\r\n"));
    }

    [Fact]
    public void BashKeepsItsLoginOptionsAndTakesTheCommandAsOneArgument()
    {
        Assert.Equal("bash --login -i -c \"echo \\\"a b\\\"\"", OneShot.CommandLine(Profile("bash --login -i", ProfileIcons.Bash), "echo \"a b\""));
    }

    [Fact]
    public void WslRunsItThroughBash()
    {
        Assert.Equal("wsl.exe -d Ubuntu -e bash -l -c \"ls\"", OneShot.CommandLine(Profile("wsl.exe -d Ubuntu", ProfileIcons.Wsl, ProfileSources.Wsl), "ls"));
    }

    [Fact]
    public void SshCantStopToAsk()
    {
        var line = OneShot.CommandLine(Profile($"{SessionProfiles.SshCommand} prod-db", ProfileIcons.Ssh, ProfileSources.Ssh), "uptime");
        Assert.Equal($"{SessionProfiles.SshCommand} -T -o ConnectTimeout=10 -o BatchMode=yes prod-db \"uptime\"", line);
    }

    [Fact]
    public void SshWithASavedPasswordLetsItsHelperAnswer()
    {
        var saved = new Dictionary<string, string> { [SshConnections.AskPassProgram] = "helper" };
        var line = OneShot.CommandLine(Profile($"{SessionProfiles.SshCommand} prod-db", ProfileIcons.Ssh, ProfileSources.Ssh, saved), "uptime");
        Assert.DoesNotContain("BatchMode", line);
    }

    [Fact]
    public void AFolderOnAServerGoesInTheRemoteCommand()
    {
        var line = OneShot.CommandLine(Profile($"{SessionProfiles.SshCommand} h", ProfileIcons.Ssh, ProfileSources.Ssh), "ls", "/var/it's");
        Assert.Contains("cd '/var/it'\\''s' && ls", line);
    }

    [Theory]
    [InlineData(ProfileSources.Local, ProfileIcons.PowerShell, true)]
    [InlineData(ProfileSources.Local, ProfileIcons.Cmd, true)]
    [InlineData(ProfileSources.Wsl, ProfileIcons.Wsl, true)]
    [InlineData(ProfileSources.Ssh, ProfileIcons.Ssh, true)]
    [InlineData(ProfileSources.Custom, ProfileIcons.Custom, false)]
    [InlineData(ProfileSources.Serial, ProfileIcons.Serial, false)]
    [InlineData(ProfileSources.Docker, ProfileIcons.Docker, false)]
    public void OnlyShellsWeKnowRunOutOfSight(string source, string icon, bool supported)
    {
        Assert.Equal(supported, OneShot.Supports(Profile("x", icon, source)));
    }

    [Fact]
    public void OutputKeepsItsEnd()
    {
        var output = new ScheduleOutput(10);
        output.Add("0123456789");
        output.Add("abc");
        Assert.Equal("3456789abc", output.ToString());
        output.Add(new string('z', 40));
        Assert.Equal(new string('z', 10), output.ToString());
    }

    [Fact]
    public async Task ARunEndsWithItsExitCodeAndOutput()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        var result = await runner.RunAsync(Job("echo scheduled-output & exit /b 3"));
        Assert.Equal(3, result.ExitCode);
        Assert.False(result.Stopped);
        Assert.Contains("scheduled-output", result.Output);
    }

    [Theory]
    [InlineData("cmd /c exit 7", 7)]
    [InlineData("Write-Error 'no'", 1)]
    [InlineData("Write-Output 'fine'", 0)]
    [InlineData("$a = 'two'\nWrite-Output \"line $a\"", 0)]
    public async Task PowerShellEndsWithWhatItsCommandEndedWith(string command, int code)
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        var line = OneShot.CommandLine(Profile("powershell.exe", ProfileIcons.PowerShell), command);
        var job = new ScheduleJob("ps", new PtyOptions(line, ScheduleRunner.Columns, ScheduleRunner.Rows), TimeSpan.FromSeconds(60));
        Assert.Equal(code, (await runner.RunAsync(job)).ExitCode);
    }

    [Fact]
    public async Task ARunThatWorkedEndsWithZero()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        Assert.Equal(0, (await runner.RunAsync(Job("echo fine"))).ExitCode);
    }

    [Fact]
    public async Task ARunOverItsLimitIsStopped()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        var result = await runner.RunAsync(Job("ping -n 60 127.0.0.1", seconds: 1));
        Assert.True(result.Stopped);
        Assert.Null(result.ExitCode);
    }

    [Fact]
    public async Task ARunCanBeStopped()
    {
        if (!OperatingSystem.IsWindows())
        {
            return;
        }
        using var runner = new ScheduleRunner(PseudoTerminal.Start);
        var job = Job("ping -n 60 127.0.0.1");
        var run = runner.RunAsync(job);
        await Task.Delay(500);
        runner.Stop(job.RunId);
        Assert.True((await run).Stopped);
    }
}

/// <summary>What's kept of a run, in the vault.</summary>
[Collection("Environment")]
public sealed class ScheduleReportTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));
    private readonly ScheduleReports _reports;

    public ScheduleReportTests()
    {
        _reports = new ScheduleReports(Vault.Open(_dir));
    }

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    [Fact]
    public void AReportComesBackAsItWasKept()
    {
        _reports.Save("r1", "line one\r\n\u001b[32mgreen\u001b[0m");
        Assert.Equal("line one\r\n\u001b[32mgreen\u001b[0m", _reports.Read("r1"));
    }

    [Fact]
    public void AReportIsNotPlainOnDisk()
    {
        _reports.Save("r1", "secret-output");
        var file = Directory.GetFiles(_dir, "r1.tmr", SearchOption.AllDirectories).Single();
        Assert.DoesNotContain("secret-output", File.ReadAllText(file), StringComparison.Ordinal);
    }

    [Fact]
    public void AForgottenReportIsGone()
    {
        _reports.Save("r1", "x");
        _reports.Forget(["r1", "never-kept"]);
        Assert.Null(_reports.Read("r1"));
    }

    [Theory]
    [InlineData("../keys")]
    [InlineData("a/b")]
    [InlineData("a.b")]
    [InlineData("")]
    public void AnIdCantLeadOutOfTheFolder(string id)
    {
        _reports.Save(id, "x");
        Assert.Null(_reports.Read(id));
        _reports.Forget([id]);
        Assert.Empty(Directory.GetFiles(_dir, "*.tmr", SearchOption.AllDirectories));
    }
}

/// <summary>Reports saved to files, as a schedule asks.</summary>
public sealed class ReportFileTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        if (Directory.Exists(_dir))
        {
            Directory.Delete(_dir, recursive: true);
        }
    }

    [Fact]
    public void ANameWithoutAFolderGoesInTermillysDocuments()
    {
        Assert.Equal(Path.Combine(AppPaths.DocumentsFolder, "reports", "a.md"), ReportFiles.Resolve("reports/a.md"));
    }

    [Fact]
    public void AFullPathStaysAsItIs()
    {
        var path = Path.Combine(_dir, "x.md");
        Assert.Equal(path, ReportFiles.Resolve(path));
    }

    [Fact]
    public void TheHomeFolderIsWrittenAsATilde()
    {
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "r.md"), ReportFiles.Resolve("~/r.md"));
    }

    [Fact]
    public void AFileIsMadeWithItsFolderThenGetsTheNextReportAtItsEnd()
    {
        var path = Path.Combine(_dir, "deep", "log.md");
        ReportFiles.Save(path, "## first\n");
        ReportFiles.Save(path, "## second\n");
        var text = File.ReadAllText(path);
        Assert.StartsWith("## first\n", text);
        Assert.EndsWith("## second\n", text);
    }
}
