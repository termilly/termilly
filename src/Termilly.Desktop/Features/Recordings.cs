using System.Collections.Concurrent;
using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>Recordings of terminals (Recording.cs, asciinema .cast files) and the player's list of them (js/replay.js).</summary>
internal sealed class RecordingHandler : IMessageHandler
{
    /// <summary>The biggest recording the player opens.</summary>
    /// <summary>A megabyte, as a shift.</summary>
    private const int MegabyteShift = 20;
    private const long MaxPlayable = 50L << MegabyteShift;
    private const string CastExtension = ".cast";
    private const string DefaultTitle = "terminal";

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly IDesktopShell _desktop;
    private readonly ConcurrentDictionary<string, Recording> _recordings = new();

    public RecordingHandler(PageChannel page, ISettingsStore settings, IDesktopShell desktop, TerminalSessions terminals)
    {
        (_page, _settings, _desktop) = (page, settings, desktop);
        terminals.Output += Output;
        terminals.Resized += (id, columns, rows) =>
        {
            if (_recordings.TryGetValue(id, out var recording))
            {
                recording.Resize(columns, rows);
            }
        };
        terminals.Closed += Stop;
    }

    private string Folder => string.IsNullOrWhiteSpace(_settings.Current.Recording.Folder) ? Recording.DefaultFolder : _settings.Current.Recording.Folder;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.RecStart>(Start);
        router.On<FromPage.RecStop>(m =>
        {
            Stop(m.Id);
            _page.Post(new ToPage.RecStatus(m.Id, null));
        });
        router.On<FromPage.RecMark>(m =>
        {
            if (_recordings.TryGetValue(m.Id, out var marked))
            {
                marked.Mark(m.Label ?? "");
            }
        });
        router.On<FromPage.RecList>(_ => Task.Run(() => _page.Post(new ToPage.RecList(Recording.List(Folder)))));
        router.On<FromPage.RecLoad>(m => Task.Run(() => Load(m.Path)));
        router.On<FromPage.RecReveal>(m => _desktop.ShowPath(m.Path ?? Folder));
    }

    private void Start(FromPage.RecStart msg)
    {
        var id = msg.Id;
        if (_recordings.TryGetValue(id, out var running))
        {
            _page.Post(new ToPage.RecStatus(id, running.Path));
            return;
        }
        try
        {
            var settings = _settings.Current;
            var title = msg.Title ?? DefaultTitle;
            var recording = new Recording(Recording.PathFor(Folder, title, DateTime.Now), msg.Cols, msg.Rows, title, settings.Recording.Redact,
                (long)Math.Max(1, settings.Recording.MaxMb) << MegabyteShift);
            if (msg.Seed is { Length: > 0 } seed)
            {
                recording.Output(seed);
            }
            _recordings[id] = recording;
            _page.Post(new ToPage.RecStatus(id, recording.Path));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or NotSupportedException)
        {
            _page.Post(new ToPage.RecFailed(id, e.Message));
        }
    }

    private void Output(string id, string data)
    {
        if (!_recordings.TryGetValue(id, out var recording))
        {
            return;
        }
        recording.Output(data);
        if (recording.Full && _recordings.TryRemove(id, out _))
        {
            _page.Post(new ToPage.RecFull(id, recording.Path));
        }
    }

    private void Stop(string id)
    {
        if (_recordings.TryRemove(id, out var recording))
        {
            recording.Dispose();
        }
    }

    /// <summary>A recording's text for the player; only .cast files, and not too big.</summary>
    private void Load(string? path)
    {
        try
        {
            if (path is null || !path.EndsWith(CastExtension, StringComparison.OrdinalIgnoreCase) || new FileInfo(path).Length > MaxPlayable)
            {
                throw new IOException("Not a recording Termilly can play.");
            }
            _page.Post(new ToPage.RecData(path, Path.GetFileName(path), File.ReadAllText(path)));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException)
        {
            _page.Post(new ToPage.RecDataFailed(path, e.Message));
        }
    }
}

/// <summary>Terminals whose output goes to a log file (SessionLog.cs), as text or the terminal's raw bytes.</summary>
internal sealed class LogHandler : IMessageHandler
{
    private const string DefaultWorkspace = "workspace";

    private readonly PageChannel _page;
    private readonly ISettingsStore _settings;
    private readonly IDesktopShell _desktop;
    private readonly ConcurrentDictionary<string, SessionLog> _logs = new();

    public LogHandler(PageChannel page, ISettingsStore settings, IDesktopShell desktop, TerminalSessions terminals)
    {
        (_page, _settings, _desktop) = (page, settings, desktop);
        terminals.Output += (id, data) =>
        {
            if (_logs.TryGetValue(id, out var log))
            {
                log.Output(data);
            }
        };
        terminals.Closed += Stop;
    }

    private string Folder => string.IsNullOrWhiteSpace(_settings.Current.Logging.Folder) ? SessionLog.DefaultFolder : _settings.Current.Logging.Folder;

    public void Register(MessageRouter router)
    {
        router.On<FromPage.LogStart>(m => Start(m.Id, m.Workspace ?? DefaultWorkspace, m.Name ?? m.Id));
        router.On<FromPage.LogLines>(m =>
        {
            if (_logs.TryGetValue(m.Id, out var log))
            {
                log.Lines(m.Lines ?? []);
            }
        });
        router.On<FromPage.LogStop>(m =>
        {
            Stop(m.Id);
            _page.Post(new ToPage.LogStopped(m.Id));
        });
        router.On<FromPage.LogReveal>(m => _desktop.ShowPath(_logs.TryGetValue(m.Id, out var shown) ? shown.Path : Folder));
    }

    /// <summary>Starts logging a terminal (the page asks: its menu, or a tag or profile that always logs).</summary>
    private void Start(string id, string workspace, string name)
    {
        if (_logs.TryGetValue(id, out var running))
        {
            _page.Post(new ToPage.LogStatus(id, running.Path, running.Raw));
            return;
        }
        try
        {
            var settings = _settings.Current;
            var raw = settings.Logging.Format == SettingValues.LogFormat.Raw;
            SessionLog.DeleteOld(Folder, settings.Logging.KeepDays);
            var log = new SessionLog(SessionLog.PathFor(Folder, workspace, name, DateTime.Now, raw), raw, settings.Logging.Timestamps, settings.Logging.Redact);
            _logs[id] = log;
            _page.Post(new ToPage.LogStatus(id, log.Path, raw));
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or NotSupportedException)
        {
            _page.Post(new ToPage.LogFailed(id, e.Message));
        }
    }

    private void Stop(string id)
    {
        if (_logs.TryRemove(id, out var log))
        {
            log.Dispose();
        }
    }
}
