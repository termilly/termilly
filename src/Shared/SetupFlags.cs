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
    /// <summary>In-app update status window; its optional value is the initiating user's event scope.</summary>
    public const string UpdateWindow = "--update-window";
    /// <summary>
    /// With --update-window, an automatic update at start: setup never closes anything, keeps the old folder until the
    /// new version reports healthy (UpdateSignals.Healthy), and puts it back otherwise.
    /// </summary>
    public const string UpdateSupervise = "--update-supervise";
    /// <summary>Run at sign-in (HKCU Run) while an automatic update is unsettled: finishes or undoes it.</summary>
    public const string UpdateRecover = "--update-recover";
    public const string AllUsers = "--all-users";
    /// <summary>The folder to install in, as the next argument.</summary>
    public const string Dir = "--dir";
}
