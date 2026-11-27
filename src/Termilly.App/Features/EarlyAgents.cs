using Termilly.Desktop.Messaging;
using Termilly.Desktop.Security;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// At start, before the page is up: the agent sessions the last snapshot resumes (<see cref="AgentStart"/>) start
/// now, each in its own terminal's shell, so an agent is back a few seconds sooner (the page takes 2 to 3 seconds to
/// load, and the shell and the agent their own time after it). Only where the page itself would type the resume
/// command at a local shell's first prompt: not with background shells (the host keeps those running), nor without
/// shell integration or a restored session.
/// </summary>
internal sealed class EarlyAgents(
    ISettingsStore settings, Vault vault, SessionSnapshot snapshot, ProfileCatalog profiles, TerminalHandler terminals) : IStartable
{
    /// <summary>A saved size outside this is no size at all: the page's own fits it at once.</summary>
    private const int MaxCells = 1000;

    public void Start()
    {
        var current = settings.Current;
        if (vault.IsLocked || current.Session.Restore != SettingValues.RestoreSession.Scrollback || current.Session.BackgroundShells
            || !current.Shells.Integration)
        {
            return;
        }
        var started = 0;
        foreach (var planned in snapshot.AgentStarts().Where(Startable))
        {
            if (terminals.StartEarly(planned))
            {
                started++;
            }
        }
        if (started > 0)
        {
            StartupLog.Mark($"early start: {started} agent session(s)");
        }
    }

    /// <summary>A start the page would have made itself: a local shell's, in a folder that's there, at a real size.</summary>
    private bool Startable(PlannedStart planned)
    {
        var start = planned.Start;
        return start.Profile is { } profile && profiles.Has(profile) && profiles.Find(profile).Source != ProfileSources.Ssh
            && start.Command is { Length: > 0 } command && !command.Any(char.IsControl)
            && start.Folder is { } folder && Directory.Exists(folder)
            && start.Cols is > 0 and <= MaxCells && start.Rows is > 0 and <= MaxCells;
    }
}
