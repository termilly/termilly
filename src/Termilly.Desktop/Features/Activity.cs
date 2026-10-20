using System.ComponentModel;
using System.Diagnostics;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Whether each terminal runs a command or waits on the user in a program (BusyWatcher), following Settings ›
/// Terminal › Show activity.
/// </summary>
internal sealed class ActivityWatcher : IStartable, IDisposable
{
    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly TerminalSessions _terminals;
    private BusyWatcher? _watcher;

    public ActivityWatcher(PageChannel page, ISettingsStore settings, TerminalSessions terminals)
    {
        (_page, _settings, _terminals) = (page, settings, terminals);
        settings.Saved += _ => Update();
    }

    public void Start() => Update();

    /// <summary>Enter may have started a command: look now, not on the next tick.</summary>
    public void Nudge() => _watcher?.Nudge();

    private void Update()
    {
        if (_settings.Current.Interface.ShowActivity && _watcher is null)
        {
            _watcher = new BusyWatcher(
                () => _terminals.Pids().ToDictionary(),
                (id, program) => _page.Post(new ToPage.Busy(id, program is { Interactive: false }, program?.Name, program is { Interactive: true })));
        }
        else if (!_settings.Current.Interface.ShowActivity && _watcher is not null)
        {
            _watcher.Dispose();
            _watcher = null;
        }
    }

    public void Dispose() => _watcher?.Dispose();
}

/// <summary>What the system tells about the terminals' processes: memory in use (Settings › About), ports they listen on.</summary>
internal sealed class SystemHandler(PageChannel page, TerminalSessions terminals, ISystemProcesses processes) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.MemoryMeasure>(_ => Task.Run(MeasureMemory));
        router.On<FromPage.PortsTerminals>(_ => Task.Run(PostTerminalPorts));
    }

    /// <summary>
    /// Memory in use: each terminal's processes (its shell and everything it started, the console host included), the
    /// app itself and its browser engine's processes. Working sets, in bytes.
    /// </summary>
    private void MeasureMemory()
    {
        var all = BusyWatcher.Snapshot();
        var sessions = terminals.Pids().ToDictionary(
            s => s.Key,
            s => WorkingSet(s.Value) + ClaudeAgentsPoller.Descendants(all, s.Value).Sum(p => WorkingSet(p.Id)));
        var webView = ClaudeAgentsPoller.Descendants(all, Environment.ProcessId).Where(processes.IsBrowserEngine).Sum(p => WorkingSet(p.Id));
        page.Post(new ToPage.Memory(sessions, WorkingSet(Environment.ProcessId), webView));
    }

    private static long WorkingSet(int pid)
    {
        try
        {
            using var process = Process.GetProcessById(pid);
            return process.WorkingSet64;
        }
        catch (Exception e) when (e is ArgumentException or InvalidOperationException or Win32Exception)
        {
            return 0; // ended meanwhile
        }
    }

    /// <summary>The ports each terminal's processes listen on (its shell and everything started from it).</summary>
    private void PostTerminalPorts()
    {
        try
        {
            page.Post(new ToPage.TerminalPorts(processes.TerminalPorts(terminals.Pids())));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is InvalidOperationException or Win32Exception)
        {
            // Next time.
        }
    }
}
