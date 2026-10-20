using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Platform;

namespace Termilly.Desktop.Services;

/// <summary>Sends the host's messages to the page (as JSON, through the window's <see cref="IPageSink"/>); from any thread.</summary>
internal sealed class PageChannel(IPageSink sink)
{
    /// <summary>How messages are written: camelCase, as the page reads them.</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public void Post<T>(T message)
        where T : IHostMessage => sink.Send(HostMessage.Json(message, Json));

    /// <summary>A message built as JSON already (what the host asks the page, <see cref="ToPage.PageCall"/>).</summary>
    public void PostJson(string json) => sink.Send(json);
}
