using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Coding agents in the terminals: Claude Code's hooks (AgentHooks, a pipe that also serves the termilly command and
/// MCP server), the `claude agents` fallback for unhooked Claude Code, each session's token use, Claude's own cost,
/// context and plan limits, and subagents. Follows Settings › Terminal › Agent integration and Claude usage.
/// </summary>
internal sealed class AgentMonitor : IStartable, IDisposable
{
    /// <summary>The plan is read again at most this often.</summary>
    private static readonly TimeSpan PlanFresh = TimeSpan.FromHours(1);

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly TerminalSessions _terminals;
    private readonly ChangeStore _changes;
    private readonly IProcessRunner _runner;
    private readonly ClaudePlan _claudePlan;
    private readonly PageApi _api;
    private readonly BackgroundHost _host;
    private AgentHooks? _hooks;
    private ClaudeAgentsPoller? _poller;
    /// <summary>Token use of the Claude Code session in each terminal, for its header (ClaudeUsage.cs).</summary>
    private ClaudeUsageTracker? _usage;
    private DateTime _planReadAt = DateTime.MinValue;
    private ClaudePlan.Info? _plan;

    public AgentMonitor(
        PageChannel page, ISettingsStore settings, TerminalSessions terminals, ChangeStore changes, IProcessRunner runner,
        ClaudePlan claudePlan, PageApi api, BackgroundHost host)
    {
        (_page, _settings, _terminals, _changes, _runner, _claudePlan, _api, _host) = (page, settings, terminals, changes, runner, claudePlan, api, host);
        settings.Saved += _ => Update();
        terminals.Restarting += Forget;
        terminals.Closed += Forget;
    }

    private AppSettings Settings => _settings.Current;

    public void Start() => Update();

    /// <summary>
    /// A new terminal's environment with what Claude Code's hooks need to find this window (the claude shim first on
    /// PATH, the pipe, the hook settings), when agent integration is on.
    /// </summary>
    public IReadOnlyDictionary<string, string> WithAgent(IReadOnlyDictionary<string, string> environment, string terminal) =>
        _hooks is not null && Settings.Agents.Integration && File.Exists(AgentHooks.HookExe)
            ? SessionLaunch.WithAgent(environment, terminal, _hooks.PipeName, AgentHooks.ClaudeSettingsPath, AgentHooks.AgentDirectory)
            : environment;

    /// <summary>
    /// Starts or stops listening for agent hooks, and the `claude agents` fallback for unhooked Claude Code. Terminals
    /// started while it's off don't get the claude shim, so they stay unhooked until restarted (the fallback still
    /// covers them once it's on).
    /// </summary>
    private void Update()
    {
        // The pipe always listens: the termilly command and MCP server use it too. Agent integration decides whether
        // terminals get the claude shim, and so whether hooks report at all.
        _hooks ??= new AgentHooks(OnEvent, _host.PipeName, _api.HandleAsync, OnEdit);
        if (Settings.Agents.Integration && File.Exists(AgentHooks.HookExe))
        {
            // The status line (plan limits) only with its setting on: it stands in for the user's own, which it then runs.
            var userSettings = Path.Combine(ClaudeCodeFiles.ConfigDirectory(), ClaudeCodeFiles.Settings);
            Storage.Try(() => ClaudeHookSettings.Write(AgentHooks.ClaudeSettingsPath, AgentHooks.HookExe, Settings.Agents.ClaudeUsage && Settings.Agents.ClaudeLimits, userSettings));
        }

        if (Settings.Agents.Integration && _poller is null && ClaudeAgentsPoller.FindClaude() is { } claude)
        {
            _poller = new ClaudeAgentsPoller(
                _runner,
                () => _terminals.Pids(),
                (id, state, message, session) =>
                {
                    Track(id, session, state);
                    _page.Post(new ToPage.PolledAgent(id, state, message, session));
                },
                claude);
        }
        else if (!Settings.Agents.Integration && _poller is not null)
        {
            _poller.Dispose();
            _poller = null;
        }

        if (Settings.Agents.Integration && Settings.Agents.ClaudeUsage)
        {
            _usage ??= new ClaudeUsageTracker((id, usage) => _page.Post(new ToPage.UsageReport(id, usage)));
        }
        else if (_usage is not null)
        {
            _usage.Dispose();
            _usage = null;
        }
    }

    private void Forget(string terminal) => _usage?.Forget(terminal);

    /// <summary>Follows the token use of the Claude Code session a terminal reported (the header's Claude session).</summary>
    private void Track(string pane, string? session, string state)
    {
        if (state == AgentStates.Exited)
        {
            _usage?.Forget(pane);
        }
        else
        {
            _usage?.Track(pane, session);
        }
    }

    /// <summary>
    /// An agent's hook reported in (on a pool thread); Unknown when the terminal isn't one of this window's. The change
    /// preview copies an edited file here, before the hook gets its answer and so before Claude's edit runs.
    /// </summary>
    private HookReply OnEvent(AgentEvent e) => OnEvent(e, remote: false);

    /// <summary>
    /// Claude Code's hook on a server, reported through the terminal (remote:hook): the pane is the page's own (a tmux
    /// pane has no session here), and the change preview and usage, which read files on this PC, are left out.
    /// </summary>
    public void OnRemoteEvent(AgentEvent e) => OnEvent(e, remote: true);

    private HookReply OnEvent(AgentEvent e, bool remote)
    {
        if (!remote && !_terminals.Has(e.Pane))
        {
            return HookReply.Unknown;
        }
        var settings = Settings;
        var reply = settings.Changes.Enabled && !remote ? _changes.OnEvent(e, settings) : HookReply.Ok;
        if (e.Subagent is not null || e.Event is HookEvents.SubagentStart or HookEvents.SubagentStop)
        {
            PostSubagent(e);
        }
        var limitsShown = settings.Agents.ClaudeUsage && settings.Agents.ClaudeLimits;
        if (AgentHooks.StateFor(e) is { } state)
        {
            _poller?.Hooked(e.Pane, e.Session, ended: state == AgentStates.Exited);
            if (!remote)
            {
                Track(e.Pane, e.Session, state);
            }
            if (limitsShown)
            {
                RefreshPlan(); // the plan's name shows before the first limits do
            }
            _page.Post(new ToPage.HookedAgent(e.Pane, state, e.Event, e.Tool, e.Message, e.Reason, e.Session, e.Target ?? e.File));
        }
        if (e.Status?.Limits is { } limits && limitsShown)
        {
            // The limits are the account's, not the terminal's: the page shows them on every Claude terminal.
            _page.Post(new ToPage.LimitsReport(limits.FiveHour, limits.SevenDay));
            RefreshPlan();
        }
        // Claude's own cost for the session (status line): per terminal, for the sidebar, header and day totals.
        if (e.Status?.Cost is { } cost)
        {
            _page.Post(new ToPage.CostReport(e.Pane, e.Session, cost.Usd, cost.DurationMs));
        }
        if (e.Event == HookEvents.SubagentStop && e.Subagent is { AgentId: { } subagent, Transcript: { } transcript })
        {
            _ = Task.Run(() => PostSubagentCost(e.Pane, e.Session ?? subagent, subagent, transcript));
        }
        if (e.Status?.Context is { } context && settings.Agents.ClaudeUsage)
        {
            // Claude Code's own context figures for this terminal's session; the page prefers them to the transcript's.
            _page.Post(new ToPage.ContextReport(e.Pane, e.Session, context.Used, context.Size, context.Tokens));
        }
        return reply;
    }

    /// <summary>Subagents get rows under their terminal (js/subagents.js): an Agent call, their start and stop, their tools.</summary>
    private void PostSubagent(AgentEvent e)
    {
        var s = e.Subagent;
        _page.Post(new ToPage.SubagentRow(
            e.Pane, e.Event, s?.AgentId, s?.AgentType, s?.ToolUseId, s?.Description, s?.SubagentType, s?.Background ?? false,
            s?.LaunchedId, e.Tool, e.Target ?? e.File, e.Event == HookEvents.SubagentStop ? e.Message : null, e.Session));
    }

    /// <summary>A subagent finished: its transcript's tokens, priced (Pricing.cs), for its row.</summary>
    /// <param name="session">A subagent's transcript lines carry the parent session's id.</param>
    private void PostSubagentCost(string pane, string session, string subagent, string transcript)
    {
        var usage = new TranscriptUsage(transcript, session, sidechain: true);
        usage.Read();
        var u = usage.Usage;
        _page.Post(new ToPage.SubagentCost(pane, subagent, u.EstimatedUsd, u.Model, u.Input + u.CacheWrite + u.CacheRead, u.Output));
    }

    /// <summary>
    /// Which plan the user is on (`claude auth status`): read with the first limits and then hourly at most, and the
    /// last answer sent again with every limits update (a reloaded page has lost it).
    /// </summary>
    private void RefreshPlan()
    {
        if (_plan is { } known)
        {
            _page.Post(new ToPage.PlanReport(known.Subscription, known.AuthMethod));
        }
        if (DateTime.UtcNow - _planReadAt < PlanFresh || ClaudeAgentsPoller.FindClaude() is not { } claude)
        {
            return;
        }
        _planReadAt = DateTime.UtcNow;
        _ = Task.Run(async () =>
        {
            if (await _claudePlan.ReadAsync(claude).ConfigureAwait(false) is { } plan)
            {
                _plan = plan;
                _page.Post(new ToPage.PlanReport(plan.Subscription, plan.AuthMethod));
            }
        });
    }

    /// <summary>Claude's edit itself, sent when OnEvent asked for it (change preview, "full edit" mode).</summary>
    private void OnEdit(EditContent edit)
    {
        var settings = Settings;
        if (_terminals.Has(edit.Pane) && settings.Changes.Enabled && settings.Changes.Source == SettingValues.ChangeSource.FullEdits)
        {
            _changes.OnEdit(edit, settings);
        }
    }

    public void Dispose()
    {
        _hooks?.Dispose();
        _poller?.Dispose();
        _usage?.Dispose();
    }
}

/// <summary>Termilly's shell integration on servers (shell/remote): installing and removing it, and what its hooks report.</summary>
internal sealed class RemoteHandler(PageChannel page, AgentMonitor agents) : IMessageHandler
{
    /// <summary>
    /// A server's hook reports, handled in the order the terminal printed them. Handled side by side, a turn's last
    /// PostToolUse ("working") could reach the page after its Stop ("done") and leave the terminal spinning.
    /// </summary>
    private readonly InOrder<AgentEvent> _remoteEvents = new(agents.OnRemoteEvent);

    public void Register(MessageRouter router)
    {
        router.On<FromPage.RemoteHook>(m =>
        {
            if (AgentHooks.ParseRemote(m.Id, m.Event, m.Payload) is { } remoteEvent)
            {
                _ = _remoteEvents.Add(remoteEvent);
            }
        });
        router.On<FromPage.RemoteInstall>(m => Task.Run(() => PostInstall(m.Id)));
        router.On<FromPage.RemoteRemove>(m => page.Post(new ToPage.RemoteRemove(m.Id, RemoteIntegration.RemoveCommand)));
    }

    /// <summary>"Set up Termilly on this host": the line to type, then the installer it reads (js/remotehost.js).</summary>
    private void PostInstall(string id)
    {
        try
        {
            var payload = RemoteIntegration.Payload();
            page.Post(new ToPage.RemoteInstall(id, RemoteIntegration.InstallCommand(payload.Length), payload));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            page.Post(new ToPage.RemoteInstallFailed(id, e.Message));
        }
    }
}
