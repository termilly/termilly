namespace Termilly.Shared;

/// <summary>
/// The setup flags an update uses: Termilly runs the new setup with them (UpdateInstall.cs), and setup reads them
/// (installer/TermillySetup/Engine/Quiet.cs). The rest of setup's command line is its own (SetupNames.cs).
/// </summary>
internal static class SetupFlags
{
    /// <summary>Install without the wizard.</summary>
    public const string Quiet = "--quiet";
    /// <summary>After a quiet install, start Termilly again, as the user who's signed in.</summary>
    public const string Start = "--start";
    public const string AllUsers = "--all-users";
    /// <summary>The folder to install in, as the next argument.</summary>
    public const string Dir = "--dir";
}
