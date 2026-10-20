using System.Diagnostics;
using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>
/// Saved passwords in the Linux keyring: the app saves one, ssh's askpass helper reads it, the app forgets it. Uses a
/// throwaway item in the user's keyring, removed at the end; skipped where no keyring answers (CI, containers).
/// </summary>
public sealed class KeyringTests
{
    [Fact]
    public void A_saved_password_reaches_askpass_and_is_gone_once_forgotten()
    {
        if (!OperatingSystem.IsLinux())
        {
            return;
        }
        var store = new LinuxKeyringStore();
        if (!store.IsAvailable)
        {
            return;
        }
        var target = $"Termilly/test/{Guid.NewGuid():N}";
        try
        {
            store.Save(target, "tester", "s3cret with spaces ünïcode", "Termilly test item");
            Assert.True(store.Exists(target));
            Assert.Equal("s3cret with spaces ünïcode", store.Read(target));

            // The helper as the app ships it (src/Termilly.Linux's build puts it in agent/), from the tests' own
            // configuration (bin/<Debug|Release>/net10.0).
            var configuration = Path.GetFileName(Path.GetDirectoryName(Path.TrimEndingDirectorySeparator(AppContext.BaseDirectory)))!;
            var askpass = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
                "src", "Termilly.Linux", "bin", configuration, "net10.0", "agent", "termilly-askpass"));
            Assert.True(File.Exists(askpass), askpass);
            {
                var start = new ProcessStartInfo(askpass, ["user@host's password: "]) { RedirectStandardOutput = true, UseShellExecute = false };
                start.Environment["TERMILLY_CREDENTIAL"] = $"wincred:{target}";
                using var process = Process.Start(start)!;
                var printed = process.StandardOutput.ReadToEnd();
                process.WaitForExit();
                Assert.Equal("s3cret with spaces ünïcode\n", printed);
            }
        }
        finally
        {
            store.Delete(target);
        }
        Assert.False(store.Exists(target));
        Assert.Null(store.Read(target));
    }
}
