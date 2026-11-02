using System.IO;
using System.Text.RegularExpressions;

namespace Termilly.Desktop;

/// <summary>
/// Where a WSL terminal starts: a Linux folder (the one it was last in, or one the Files panel opens it in, as Windows
/// reaches it: \\wsl.localhost\Ubuntu\home\me) goes to wsl.exe as its --cd, not as a Windows folder.
/// </summary>
internal static partial class WslFolders
{
    private const string CdOption = "--cd";
    private const string ShareRoot = @"\\wsl.localhost\";

    [GeneratedRegex(@"^\\\\wsl(?:\.localhost|\$)\\[^\\]+(?<rest>(?:\\.*)?)$", RegexOptions.IgnoreCase)]
    private static partial Regex Share();

    [GeneratedRegex(@"\s--cd\s+(?:""[^""]*""|\S+)")]
    private static partial Regex CdArgument();

    [GeneratedRegex(@"(?:^|\s)(?:-d|--distribution)\s+""?(?<name>[^\s""]+)")]
    private static partial Regex Distribution();

    /// <summary>The Linux folder a start folder is in WSL (/home/me, or \\wsl.localhost\Ubuntu\home\me), else null.</summary>
    public static string? LinuxFolder(string? folder)
    {
        if (string.IsNullOrEmpty(folder))
        {
            return null;
        }
        if (folder.StartsWith('/'))
        {
            return folder;
        }
        return Share().Match(folder) is { Success: true } m ? (m.Groups["rest"].Value.Replace('\\', '/').TrimEnd('/') is { Length: > 0 } rest ? rest : "/") : null;
    }

    /// <summary>
    /// A WSL profile's command line starting in <paramref name="linuxFolder"/>: its --cd replaced, or added. As it is
    /// when the folder is gone (it starts where it would have), or can't be passed (a quote in its name).
    /// </summary>
    public static string StartingIn(string commandLine, string linuxFolder)
    {
        if (linuxFolder.Contains('"', StringComparison.Ordinal) || !Exists(commandLine, linuxFolder))
        {
            return commandLine;
        }
        var cd = $" {CdOption} \"{linuxFolder}\"";
        return CdArgument().IsMatch(commandLine) ? CdArgument().Replace(commandLine, _ => cd, 1) : commandLine + cd;
    }

    /// <summary>Whether the folder is still there, looked at through Windows' share of the distribution the command names.</summary>
    private static bool Exists(string commandLine, string linuxFolder)
    {
        if (Distribution().Match(commandLine) is not { Success: true } m)
        {
            return true; // the default distribution: wsl.exe says so itself if it's gone
        }
        try
        {
            return Directory.Exists(ShareRoot + m.Groups["name"].Value + linuxFolder.Replace('/', '\\'));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
