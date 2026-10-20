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
    AgentMonitor agents, ActivityWatcher activity, TmuxClients tmux) : IMessageHandler
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

    /// <param name="variables">A layout's own variables for this terminal, on top of the profile's.</param>
    /// <param name="fallbackCwd">Where to start when <paramref name="cwd"/> (the folder it was last in) is gone.</param>
    private void Start(string id, string? profileId, string? cwd, int cols, int rows, Dictionary<string, string>? variables, string? fallbackCwd)
    {
        var profile = profiles.Find(profileId);
        terminals.Starting(id, profile);
        try
        {
            // A profile's own folder wins over the workspace's. A folder deleted since (outside Termilly) gives way to the
            // next one, else the home folder, and the page says so above the prompt.
            var requested = profile.WorkingDirectory ?? cwd;
            var (folder, missing) = AppPaths.StartFolder(requested, profile.WorkingDirectory is null ? fallbackCwd : null);
            if (missing)
            {
                page.Post(new ToPage.StartFolder(id, requested, folder));
            }
            var environment = agents.WithAgent(WithVariables(SessionLaunch.EnvironmentFor(profile, AppVersion.Current), variables), id);
            (var commandLine, environment) = SessionLaunch.Launch(profile, environment, settings.Current);
            void Output(string data)
            {
                page.Post(new ToPage.Output(id, data));
                terminals.Print(id, data);
            }

            // COM ports and network consoles are byte streams, not processes in a pseudo terminal.
            if (ByteStream(profile, Output) is { } stream)
            {
                terminals.Started(id, stream, 0);
                return;
            }
            var (session, pid) = StartShell(id, new PtyOptions(commandLine, cols, rows, folder, environment), Output, (code, exitedPid) =>
            {
                terminals.Exited(id, exitedPid);
                page.Post(new ToPage.Exit(id, code));
            });
            terminals.Started(id, session, pid);
        }
        catch (Exception ex)
        {
            page.Post(new ToPage.Error(id, ex.Message));
        }
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
    /// while no window was open), else here. Returns the session and its root process (0 when not known);
    /// <paramref name="exited"/> takes the exit code and that process id.
    /// </summary>
    private (IShellSession Session, int Pid) StartShell(string id, PtyOptions options, Action<string> output, Action<int, int> exited)
    {
        var background = host.Current();
        if (background is not null && background.Running.TryGetValue(id, out var kept) && kept.Alive)
        {
            // The background host kept this terminal's shell while the window was closed: take it back.
            var attached = background.Attach(id, kept.Pid, options.Columns, options.Rows, output, code => exited(code, kept.Pid));
            page.Post(new ToPage.Attached(id));
            return (attached, kept.Pid);
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
        if (!host.ShutDown())
        {
            return;
        }
        foreach (var id in hosted)
        {
            terminals.Forget(id);
            page.Post(new ToPage.Exit(id, HostedSession.EndedCode));
        }
    }

    /// <summary>A terminal's own environment variables (from a layout), if the message has any.</summary>
    private static Dictionary<string, string>? Variables(JsonElement? env) =>
        env is { ValueKind: JsonValueKind.Object } variables
            ? variables.EnumerateObject()
                .Where(v => SettingChecks.IsVariableName(v.Name) && v.Value.ValueKind == JsonValueKind.String)
                .ToDictionary(v => v.Name, v => v.Value.GetString()!, StringComparer.OrdinalIgnoreCase)
            : null;
}
