using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Termilly.Agent;

/// <summary>
/// termilly-askpass(.exe): ssh's SSH_ASKPASS for connections whose password is a reference (Settings › SSH). For a
/// password or passphrase prompt it prints the secret from TERMILLY_CREDENTIAL: "wincred:&lt;target&gt;" (Windows
/// Credential Manager, or the keyring on Linux) or "op:&lt;op://reference&gt;" (the 1Password CLI). Any other question (a new host key) goes to
/// the terminal, as ssh would have asked it there.
/// </summary>
internal static class Askpass
{
    /// <summary>The 1Password CLI, and how it reads a reference.</summary>
    private const string OnePasswordCli = "op";
    private static readonly string[] OnePasswordRead = ["read", "--no-newline"];
    private static readonly TimeSpan OnePasswordTimeout = TimeSpan.FromSeconds(30);
    /// <summary>The terminal ssh runs in: its console on Windows, else the process's terminal.</summary>
    private const string WindowsConsoleOut = "CONOUT$";
    private const string WindowsConsoleIn = "CONIN$";
    private const string UnixTerminal = "/dev/tty";

    public static int Run(string[] args)
    {
        var prompt = args.Length > 0 ? args[0] : "";
        var reference = Environment.GetEnvironmentVariable(TerminalEnvironment.Credential) ?? "";
        if (IsSecretPrompt(prompt) && Secret(reference) is { } secret)
        {
            Console.Out.Write(secret + "\n");
            return 0;
        }
        return AskOnConsole(prompt);
    }

    public static bool IsSecretPrompt(string prompt) =>
        prompt.Contains("password", StringComparison.OrdinalIgnoreCase) ||
        prompt.Contains("passphrase", StringComparison.OrdinalIgnoreCase) ||
        prompt.Contains("PIN", StringComparison.Ordinal);

    /// <summary>The secret a reference points to, or null when it can't be read (then the user is asked).</summary>
    public static string? Secret(string reference)
    {
        if (CredentialReference.Read(reference, SshIdentities.SavedPassword) is { } target)
        {
            if (OperatingSystem.IsLinux())
            {
                try
                {
                    return Termilly.Desktop.LibSecret.Lookup(target);
                }
                catch (Exception e) when (e is InvalidOperationException or DllNotFoundException or EntryPointNotFoundException)
                {
                    return null; // no keyring: the user is asked
                }
            }
            return WindowsCredentials.Read(target);
        }
        if (CredentialReference.Read(reference, SshIdentities.OnePassword) is { } secretRef)
        {
            try
            {
                var start = new ProcessStartInfo(OnePasswordCli, [.. OnePasswordRead, secretRef])
                {
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    CreateNoWindow = true,
                };
                using var op = Process.Start(start)!;
                var value = op.StandardOutput.ReadToEnd();
                op.WaitForExit(OnePasswordTimeout);
                return op.ExitCode == 0 && value.Length > 0 ? value : null;
            }
            catch (System.ComponentModel.Win32Exception)
            {
                return null; // the 1Password CLI isn't installed
            }
        }
        return null;
    }

    /// <summary>Asks on the terminal ssh runs in (its console, or /dev/tty), the way ssh itself would have.</summary>
    private static int AskOnConsole(string prompt)
    {
        var (outName, inName) = OperatingSystem.IsWindows() ? (WindowsConsoleOut, WindowsConsoleIn) : (UnixTerminal, UnixTerminal);
        try
        {
            using var output = new StreamWriter(new FileStream(outName, FileMode.Open, FileAccess.Write), Encoding.UTF8) { AutoFlush = true };
            using var input = new StreamReader(new FileStream(inName, FileMode.Open, FileAccess.Read), Encoding.UTF8);
            output.Write(prompt);
            var answer = input.ReadLine();
            if (answer is null)
            {
                return 1;
            }
            Console.Out.Write(answer + "\n");
            return 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 1; // no terminal to ask (a background forward): ssh gives up
        }
    }
}
