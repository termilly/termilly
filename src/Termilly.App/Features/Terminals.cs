using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;
using Termilly.Pty;

namespace Termilly.Desktop.Features;

/// <summary>
/// Terminals: starting their shells (here, in the background host, or a serial port or network console), typing
/// into them, resizing and closing them, files dropped on them, and tmux in control mode.
/// </summary>
internal sealed class TerminalHandler(
    PageChannel page, ISettingsStore settings, TerminalSessions terminals, ProfileCatalog profiles, BackgroundHost host,
    AgentMonitor agents, ActivityWatcher activity, TmuxClients tmux, EarlyShells early, BackgroundTasks tasks) : IMessageHandler
{

    public void Register(MessageRouter router)
    {
        router.On<FromPage.Start>(m => Start(m.Id, m.Profile, m.Cwd, m.Cols, m.Rows, Variables(m.Env), m.FallbackCwd));
        router.On<FromPage.Input>(m => Type(m.Id, m.Data ?? ""));
        router.On<FromPage.Resize>(m => terminals.Resize(m.Id, m.Cols, m.Rows));
        router.On<FromPage.Kill>(m => terminals.Close(m.Id));
        // Files dropped on a terminal: the browser hands over their paths, or the page read them itself (file:// URLs).
        router.On<FromPage.FilesDrop>((m, files) => page.Post(new ToPage.FilesDropped(m.Id, files ?? m.Paths ?? [])));
        router.On<FromPage.SerialBreak>(m => WithStream(m.Id, stream => Task.Run(stream.SendBreak)));
        router.On<FromPage.SerialHex>(m => WithStream(m.Id, stream => stream.Hex = m.On));
        router.On<FromPage.SerialEol>(m => WithStream(m.Id, stream => stream.LineEnding = LineEndings.OrDefault(m.Eol)));
        router.On<FromPage.HostShutdown>(_ => ShutDownHost());
        router.On<FromPage.HostShells>(m => ListHostShells(m.RequestId));
        // A server's (or WSL's) tmux in control mode, its panes shown as terminals (TmuxClient.cs, js/tmux.js).
        router.On<FromPage.TmuxStart>(m => tmux.Start(m.Id, m.Command ?? TmuxClients.DefaultCommand,
            data => page.Post(new ToPage.TmuxData(m.Id, data)),
            code => page.Post(new ToPage.TmuxExit(m.Id, code)),
            error => page.Post(new ToPage.TmuxFailed(m.Id, TmuxClients.FailedCode, error))));
        router.On<FromPage.TmuxWrite>(m => tmux.Write(m.Id, m.Text ?? ""));
        router.On<FromPage.TmuxStop>(m => tmux.Stop(m.Id));
    }

    private void Type(string id, string data)
    {
        if (terminals.Get(id) is { } target)
        {
            target.Write(data);
            if (data.Contains('\r'))
            {
                activity.Nudge(); // Enter may have started a command: look now, not on the next tick
            }
        }
    }

    private void WithStream(string id, Action<ByteStreamSession> act)
    {
        if (terminals.Get(id) is ByteStreamSession stream)
        {
            act(stream);
        }
    }

    /// <summary>
    /// The page opens a terminal: its shell starts, or one started for it before the page was up (EarlyAgents) is
    /// taken over as it is.
    /// </summary>
    /// <param name="variables">A layout's own variables for this terminal, on top of the profile's.</param>
    /// <param name="fallbackCwd">Where to start when <paramref name="cwd"/> (the folder it was last in) is gone.</param>
    private void Start(string id, string? profileId, string? cwd, int cols, int rows, Dictionary<string, string>? variables, string? fallbackCwd)
    {
        // Taken over before it leaves the early shells: a report that comes meanwhile still waits for the page with it.
        if (early.Get(id) is { } shell)
        {
            TakeOver(id, shell, cols, rows);
            early.Take(id);
        }
        else
        {
            try
            {
                Launch(id, profileId, cwd, cols, rows, variables, fallbackCwd, null);
            }
            catch (Exception ex)
            {
                page.Post(new ToPage.Error(id, ex.Message));
            }
        }
        tasks.Resend(id); // background tasks the page may have missed: it didn't know the terminal, or reloaded
    }

    /// <summary>
    /// Starts a terminal's agent session before the page is up (EarlyAgents): its shell, with the resume command typed
    /// at its first prompt. False when it couldn't start; the page then starts the terminal as it always does.
    /// </summary>
    public bool StartEarly(PlannedStart planned)
    {
        var (id, start) = planned;
        var shell = new EarlyShell(start.Command!, TerminalReplies.Version(AppVersion.Current));
        early.Add(id, shell);
        try
        {
            Launch(id, start.Profile, start.Folder, start.Cols, start.Rows, start.Env, null, shell);
            shell.TypeWithoutMarks();
            return true;
        }
        catch (Exception ex) when (ex is IOException or InvalidOperationException or UnauthorizedAccessException or System.ComponentModel.Win32Exception)
        {
            StartupLog.Mark($"early start of {id} failed: {ex.Message}");
            early.Take(id)?.Dispose();
            terminals.Close(id);
            return false;
        }
    }

    /// <summary>The page opened a terminal whose shell started before it: the shell is its own from now on.</summary>
    private void TakeOver(string id, EarlyShell shell, int cols, int rows)
    {
        terminals.Resize(id, cols, rows);
        shell.Take(data => Printed(id, data), data => Replayed(id, data), code => page.Post(new ToPage.Exit(id, code)));
        StartupLog.Mark($"shell {id} taken over from the early start");
    }

    /// <summary>
    /// Starts a terminal's shell. Its output goes to the page, or to <paramref name="early"/> until the page takes it
    /// over; the page hears of a missing folder only when it asked for the start itself.
    /// </summary>
    private void Launch(string id, string? profileId, string? cwd, int cols, int rows, Dictionary<string, string>? variables, string? fallbackCwd, EarlyShell? early)
    {
        var profile = profiles.Find(profileId);
        terminals.Starting(id, profile);
        // A profile's own folder wins over the workspace's. A folder deleted since (outside Termilly) gives way to the
        // next one, else the home folder, and the page says so above the prompt.
        // A WSL terminal's Linux folder goes to wsl.exe (--cd), not to Windows (WslFolders).
        var linuxFolder = profile.Source == ProfileSources.Wsl && profile.WorkingDirectory is null ? WslFolders.LinuxFolder(cwd) : null;
        var requested = profile.WorkingDirectory ?? (linuxFolder is null ? cwd : null);
        var (folder, missing) = AppPaths.StartFolder(requested, profile.WorkingDirectory is null ? fallbackCwd : null);
        if (missing && early is null)
        {
            page.Post(new ToPage.StartFolder(id, requested, folder));
        }
        var environment = agents.WithAgent(WithVariables(SessionLaunch.EnvironmentFor(profile, AppVersion.Current), variables), id);
        (var commandLine, environment) = SessionLaunch.Launch(profile, environment, settings.Current);
        if (linuxFolder is not null)
        {
            commandLine = WslFolders.StartingIn(commandLine, linuxFolder);
        }
        Action<string> output = early is null ? data => Printed(id, data) : early.Print;
        Action<int> ended = early is null ? code => page.Post(new ToPage.Exit(id, code)) : early.Exited;

        // COM ports and network consoles are byte streams, not processes in a pseudo terminal.
        if (ByteStream(profile, output) is { } stream)
        {
            terminals.Started(id, stream, 0);
            return;
        }
        var took = System.Diagnostics.Stopwatch.StartNew();
        var (session, pid) = StartShell(id, new PtyOptions(commandLine, cols, rows, folder, environment), output, data => Replayed(id, data), (code, exitedPid) =>
        {
            terminals.Exited(id, exitedPid);
            ended(code);
        });
        early?.Session = session;
        StartupLog.Mark($"shell {id} ({profile.Name}, {session.GetType().Name}{(early is null ? "" : ", early")}) in {took.ElapsedMilliseconds} ms");
        terminals.Started(id, session, pid);
    }

    private void Printed(string id, string data)
    {
        page.Post(new ToPage.Output(id, data));
        terminals.Print(id, data);
    }

    /// <summary>A kept shell's missed output, drawn again: not news, so the page doesn't answer or announce it.</summary>
    private void Replayed(string id, string data)
    {
        page.Post(new ToPage.Replay(id, data));
        terminals.Print(id, data);
    }

    private static IReadOnlyDictionary<string, string> WithVariables(IReadOnlyDictionary<string, string> environment, Dictionary<string, string>? variables)
    {
        if (variables is not { Count: > 0 })
        {
            return environment;
        }
        var merged = new Dictionary<string, string>(environment, StringComparer.OrdinalIgnoreCase);
        foreach (var (name, value) in variables)
        {
            merged[name] = value;
        }
        return merged;
    }

    private ByteStreamSession? ByteStream(SessionProfile profile, Action<string> output)
    {
        var current = settings.Current;
        if (StreamCommands.Target(profile.CommandLine, StreamCommands.Serial) is { } port)
        {
            var serial = current.Shells.SerialPorts?.FirstOrDefault(s => s.Port.Equals(port, StringComparison.OrdinalIgnoreCase)) ?? new SerialSettings(port);
            return ByteStreamSession.ForSerial(serial, port, output);
        }
        if (StreamCommands.Target(profile.CommandLine, StreamCommands.Network) is { } id &&
            current.Shells.NetworkConsoles?.FirstOrDefault(c => c.Id == id) is { } console)
        {
            return ByteStreamSession.ForNetwork(console, output);
        }
        return null;
    }

    /// <summary>
    /// Starts a terminal's shell: in the background host when Settings keep shells running (taking back one it kept
    /// while no window was open, whose missed output goes to <paramref name="replay"/>), else here. Returns the session
    /// and its root process (0 when not known); <paramref name="exited"/> takes the exit code and that process id.
    /// </summary>
    private (IShellSession Session, int Pid) StartShell(string id, PtyOptions options, Action<string> output, Action<string> replay, Action<int, int> exited)
    {
        var background = host.Current();
        if (background?.TakeKept(id) is { } keptPid)
        {
            // The background host kept this terminal's shell while the window was closed: take it back.
            var attached = background.Attach(id, keptPid, options.Columns, options.Rows, output, replay, code => exited(code, keptPid));
            page.Post(new ToPage.Attached(id));
            return (attached, keptPid);
        }
        if (background is not null)
        {
            HostedSession? hosted = null;
            hosted = background.Start(id, options, output,
                code => exited(code, hosted?.ProcessId ?? 0), message => page.Post(new ToPage.Error(id, message)));
            return (hosted, hosted.ProcessId);
        }
        var pty = PseudoTerminal.Start(options);
        var pid = pty.ProcessId;
        return (new TerminalSession(pty, output, code => exited(code, pid)), pid);
    }

    /// <summary>"Stop background shells": the host ends, and its terminals with it.</summary>
    private void ShutDownHost()
    {
        var hosted = terminals.Hosted();
        _ = host.ShutDown();
        foreach (var id in hosted)
        {
            terminals.Forget(id);
            page.Post(new ToPage.Exit(id, HostedSession.EndedCode, Ended: true));
        }
    }

    /// <summary>The terminals whose shells the background host runs: this window's, and kept ones not taken back.</summary>
    private void ListHostShells(string? requestId) => Task.Run(() =>
        page.Post(new ToPage.HostShellList(requestId, [.. terminals.LiveHosted().Union(host.KeptShells())])));

    /// <summary>A terminal's own environment variables (from a layout), if the message has any.</summary>
    private static Dictionary<string, string>? Variables(JsonElement? env) =>
        env is { ValueKind: JsonValueKind.Object } variables
            ? variables.EnumerateObject()
                .Where(v => SettingChecks.IsVariableName(v.Name) && v.Value.ValueKind == JsonValueKind.String)
                .ToDictionary(v => v.Name, v => v.Value.GetString()!, StringComparer.OrdinalIgnoreCase)
            : null;
}
