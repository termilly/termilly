using System.Diagnostics;
using Termilly.Desktop;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// Installs an update on Linux: apt installs the downloaded package through pkexec (the desktop's password prompt),
/// then a small script starts the new Termilly once this one has closed. Without pkexec, or without a prompt to ask
/// with, the user gets the command to run themselves. The background host keeps running the shells it has.
/// </summary>
internal sealed class LinuxUpdateInstaller(IProcessRunner processes) : IUpdateInstaller
{
    /// <summary>The password prompt waits for the user, and apt may fetch what the package needs.</summary>
    private static readonly TimeSpan InstallTimeout = TimeSpan.FromMinutes(15);
    private const string Shell = "/bin/sh";
    /// <summary>The shell runs the script that follows.</summary>
    private const string Script = "-c";

    public bool EndsKeptShells => false;

    public async Task<UpdateInstallResult> InstallAsync(string file, CancellationToken cancel)
    {
        ProcessResult result;
        try
        {
            result = await processes.RunAsync(new ProcessRequest(PackageCommands.Elevate, PackageCommands.Install(file)) { Timeout = InstallTimeout }, cancel)
                .ConfigureAwait(false);
        }
        catch (ProgramMissingException)
        {
            return UpdateInstallResult.ByHand(PackageCommands.ByHand(file));
        }
        catch (ProcessTimeoutException)
        {
            return UpdateInstallResult.Failed("Installing took too long and was stopped.");
        }
        return result.ExitCode switch
        {
            0 => Restart(),
            PackageCommands.Dismissed => UpdateInstallResult.Failed("The password prompt was closed, so nothing was installed."),
            PackageCommands.NotAuthorized => UpdateInstallResult.ByHand(PackageCommands.ByHand(file)),
            _ => UpdateInstallResult.Failed($"apt couldn't install the update: {result.FirstErrorLine ?? $"exit code {result.ExitCode}"}"),
        };
    }

    /// <summary>The new version is installed: the script waits for this window to close, then starts it.</summary>
    private static UpdateInstallResult Restart()
    {
        try
        {
            var start = new ProcessStartInfo(Shell) { UseShellExecute = false };
            start.ArgumentList.Add(Script);
            start.ArgumentList.Add(PackageCommands.RestartScript(Environment.ProcessId));
            Process.Start(start)?.Dispose();
        }
        catch (Exception e) when (e is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            // Installed all the same: closing now leaves the new version for the next start.
        }
        return UpdateInstallResult.Running;
    }
}
