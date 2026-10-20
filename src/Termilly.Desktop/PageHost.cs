using System.Text.Json;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>
/// What the page talks to, on Windows and Linux alike. Each feature handles its own messages (Features/, registered
/// in Services/Composition.cs); this hands each message to its feature, starts what runs alongside the page once the
/// window is up, and tells the window whether to wait for a last snapshot before it closes.
/// </summary>
internal sealed class PageHost(IEnumerable<IMessageHandler> handlers, IEnumerable<IStartable> startables, LastSnapshot lastSnapshot)
{
    /// <summary>The longest part of a message an unknown one is reported with.</summary>
    private const int ReportedLength = 80;

    private MessageRouter? _router;

    /// <summary>Whether a closing window should first ask the page for a last snapshot of what its terminals show.</summary>
    public bool WantsLastSnapshot => lastSnapshot.Wanted;

    /// <summary>Asks the page for a last snapshot before the window closes (it answers with snapshot:save, final).</summary>
    public void RequestSnapshot() => lastSnapshot.Request();

    /// <summary>
    /// Starts what runs alongside the page, once the window is up: the activity watcher, agent hooks and the API pipe,
    /// the running containers, port forwards that start on their own, phone check-in and the update check.
    /// </summary>
    public void Start()
    {
        foreach (var startable in startables)
        {
            startable.Start();
        }
    }

    /// <param name="msg">The message, as the page sent it.</param>
    /// <param name="files">Files the page handed over with the message (dropped or picked), where the browser gives their paths.</param>
    public void OnMessage(JsonElement msg, IReadOnlyList<string>? files = null)
    {
        _router ??= CreateRouter();
        if (!_router.Dispatch(msg, files))
        {
            var text = msg.GetRawText();
            Console.Error.WriteLine($"termilly: nothing handles the page's message {text[..Math.Min(ReportedLength, text.Length)]}");
        }
    }

    private MessageRouter CreateRouter()
    {
        var router = new MessageRouter(Services.PageChannel.Json);
        foreach (var handler in handlers)
        {
            handler.Register(router);
        }
        return router;
    }
}
