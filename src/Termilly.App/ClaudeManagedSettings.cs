using System.IO;
using Microsoft.Win32;

namespace Termilly.Desktop;

/// <summary>
/// Whether an organization manages Claude Code's settings on this computer. Its restrictions come by more ways than can
/// be read from here, so where there's any sign of them, nothing Claude Code allows is carried over to Codex
/// (<see cref="AgentRules"/>).
/// </summary>
internal static class ClaudeManagedSettings
{
    /// <summary>
    /// Whether an organization manages Claude Code's settings on this computer, as far as files and policies show: its
    /// managed settings file or folder, a Windows policy, or a macOS profile. Settings an organization delivers from
    /// Anthropic's servers leave no sign that can be relied on, and aren't seen.
    /// </summary>
    public static bool Present()
    {
        const string ManagedFile = "managed-settings.json";
        const string DropIns = "managed-settings.d";
        const string Product = "ClaudeCode";
        const string PolicyKey = @"SOFTWARE\Policies\" + Product;
        string[] folders = OperatingSystem.IsWindows()
            ? [Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Product), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), Product)]
            : OperatingSystem.IsMacOS() ? ["/Library/Application Support/ClaudeCode"] : ["/etc/claude-code"];
        if (folders.Any(folder => File.Exists(Path.Combine(folder, ManagedFile)) || Directory.Exists(Path.Combine(folder, DropIns))))
        {
            return true;
        }
        if (OperatingSystem.IsMacOS())
        {
            const string Profile = "com.anthropic.claudecode.plist";
            const string Profiles = "/Library/Managed Preferences";
            return File.Exists(Path.Combine(Profiles, Profile)) || File.Exists(Path.Combine(Profiles, Environment.UserName, Profile));
        }
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }
        using var machine = Registry.LocalMachine.OpenSubKey(PolicyKey);
        using var user = Registry.CurrentUser.OpenSubKey(PolicyKey);
        return machine is not null || user is not null;
    }

}
