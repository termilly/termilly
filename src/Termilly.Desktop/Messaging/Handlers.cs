namespace Termilly.Desktop.Messaging;

/// <summary>A feature's side of the page's messages: it registers what each of its messages does.</summary>
internal interface IMessageHandler
{
    void Register(MessageRouter router);
}

/// <summary>Something that runs alongside the page once the window is up (watchers, servers, timers).</summary>
internal interface IStartable
{
    void Start();
}
