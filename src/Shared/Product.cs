namespace Termilly.Shared;

/// <summary>Termilly's own name: for its folders, window, notifications and what it tells programs it is.</summary>
internal static class Product
{
    public const string Name = "Termilly";
    /// <summary>The docs on the website; a section is its #id (Settings’ help button opens one).</summary>
    public const string DocsUrl = "https://termilly.com/docs/";
}

/// <summary>The platform names .NET's platform attributes take (SupportedOSPlatform and its kin).</summary>
internal static class OsPlatforms
{
    public const string Windows = "windows";
}

/// <summary>Where Git for Windows installs, and Git Bash in it (Windows only).</summary>
internal static class GitForWindows
{
    /// <summary>Its folder under Program Files, or the user's Programs.</summary>
    public const string Folder = "Git";
    public const string UserPrograms = "Programs";
    public const string Bin = "bin";
    public const string BashExe = "bash.exe";
    public const string GitExe = "git.exe";
}
