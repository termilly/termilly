using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Services;

/// <summary>
/// Whether closing the window quits now or asks first. The page knows what is still running (a command, an agent at
/// work or waiting for you), so it's asked (quit:ask) and answers (quit:answer): quit, stay, or that it's asking the
/// user. A page that doesn't answer at all (stuck, or not loaded yet) can't keep Termilly from quitting: after a
/// moment it quits anyway.
/// </summary>
internal sealed class QuitGate : IDisposable
{
    /// <summary>How long a quit waits for the page to answer before it goes ahead.</summary>
    private static readonly TimeSpan DefaultAnswerWait = TimeSpan.FromSeconds(30);

    private readonly PageChannel _page;
    private readonly TimeSpan _answerWait;
    private readonly Lock _lock = new();
    private Timer? _wait;
    private Action? _quit;
    private volatile bool _quitting;

    public QuitGate(PageChannel page)
        : this(page, DefaultAnswerWait)
    {
    }

    /// <param name="answerWait">How long to wait for the page (tests make it short).</param>
    internal QuitGate(PageChannel page, TimeSpan answerWait) => (_page, _answerWait) = (page, answerWait);

    /// <summary>Quitting is decided: the window closes without asking again.</summary>
    public bool Quitting => _quitting;

    /// <summary>Quit without asking: an update restarting Termilly, the system shutting down, or the page said so.</summary>
    public void Allow() => _quitting = true;

    /// <summary>The user wants to quit: the page asks if something is running, and <paramref name="quit"/> closes the window once it may.</summary>
    public void Ask(Action quit)
    {
        lock (_lock)
        {
            _quit = quit;
            _wait?.Dispose();
            _wait = new Timer(_ => Answer(QuitAnswers.Quit), null, _answerWait, Timeout.InfiniteTimeSpan);
        }
        _page.Post(new ToPage.QuitAsk());
    }

    /// <summary>The page's answer: quit, stay, or it's asking the user (who may take their time).</summary>
    public void Answer(string? answer)
    {
        Action? quit;
        lock (_lock)
        {
            _wait?.Dispose();
            _wait = null;
            if (answer != QuitAnswers.Quit)
            {
                if (answer == QuitAnswers.Stay)
                {
                    _quit = null;
                }
                return;
            }
            (quit, _quit) = (_quit, null);
        }
        if (quit is not null)
        {
            Allow();
            quit();
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _wait?.Dispose();
            _wait = null;
        }
    }
}
