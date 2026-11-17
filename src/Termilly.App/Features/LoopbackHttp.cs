using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;

namespace Termilly.Desktop.Features;

/// <summary>
/// Just enough HTTP/1.1 on 127.0.0.1 for the test driver (<see cref="TestDriver"/>): one request per connection, a
/// request line, headers and a Content-Length body in, a status and a JSON body out, then the connection closes.
/// Not .NET's HttpListener: its managed one (Linux, macOS) could throw inside Start when a connection was already
/// waiting as it began accepting (a test asking /ready at once), which brought the whole app down. A TcpListener is
/// listening from Start on, and accepts on its own loop.
/// </summary>
internal sealed class LoopbackHttp(int port, Func<LoopbackRequest, Task<LoopbackResponse>> handle) : IDisposable
{
    private const int MaxHeaderBytes = 16 * 1024;
    private const int MaxBodyBytes = 16 * 1024 * 1024;
    private const string ContentLength = "content-length";
    private static readonly Encoding Latin1 = Encoding.Latin1;
    private readonly TcpListener _listener = new(IPAddress.Loopback, port);
    private readonly CancellationTokenSource _stop = new();

    public void Start()
    {
        _listener.Start();
        _ = AcceptAsync();
    }

    private async Task AcceptAsync()
    {
        try
        {
            while (!_stop.IsCancellationRequested)
            {
                var client = await _listener.AcceptTcpClientAsync(_stop.Token).ConfigureAwait(false);
                _ = ServeAsync(client);
            }
        }
        catch (Exception e) when (e is OperationCanceledException or ObjectDisposedException or SocketException)
        {
            // Stopping ends the pending accept.
        }
    }

    private async Task ServeAsync(TcpClient client)
    {
        using (client)
        {
            var stream = client.GetStream();
            try
            {
                var request = await ReadAsync(stream).ConfigureAwait(false);
                var response = request is null ? LoopbackResponse.Status(HttpStatusCode.BadRequest) : await handle(request).ConfigureAwait(false);
                await WriteAsync(stream, response).ConfigureAwait(false);
            }
            catch (Exception e) when (e is IOException or ObjectDisposedException or SocketException)
            {
                // A test may time out and disconnect before its page answers.
            }
        }
    }

    /// <summary>The request, or null when it isn't one this understands (too big, no request line).</summary>
    private static async Task<LoopbackRequest?> ReadAsync(NetworkStream stream)
    {
        var head = new MemoryStream();
        var last = new byte[4];
        while (head.Length < MaxHeaderBytes)
        {
            var b = stream.ReadByte();
            if (b < 0)
            {
                return null;
            }
            head.WriteByte((byte)b);
            Array.Copy(last, 1, last, 0, 3);
            last[3] = (byte)b;
            if (last is [(byte)'\r', (byte)'\n', (byte)'\r', (byte)'\n'])
            {
                break;
            }
        }
        var lines = Latin1.GetString(head.ToArray()).Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        var start = lines.FirstOrDefault()?.Split(' ');
        if (start is not { Length: >= 2 })
        {
            return null;
        }
        var headers = lines.Skip(1).Select(l => l.Split(':', 2)).Where(p => p.Length == 2)
            .ToDictionary(p => p[0].Trim().ToLowerInvariant(), p => p[1].Trim());
        var length = headers.TryGetValue(ContentLength, out var text) && int.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0;
        if (length > MaxBodyBytes)
        {
            return null;
        }
        var body = new byte[length];
        await stream.ReadExactlyAsync(body).ConfigureAwait(false);
        return new LoopbackRequest(start[0], start[1].Split('?')[0], headers, body);
    }

    private static async Task WriteAsync(NetworkStream stream, LoopbackResponse response)
    {
        var body = response.Json is null ? [] : Encoding.UTF8.GetBytes(response.Json);
        var head = $"HTTP/1.1 {(int)response.Code} {response.Code}\r\nContent-Type: application/json\r\n" +
            $"Content-Length: {body.Length.ToString(CultureInfo.InvariantCulture)}\r\nConnection: close\r\n\r\n";
        await stream.WriteAsync(Latin1.GetBytes(head)).ConfigureAwait(false);
        await stream.WriteAsync(body).ConfigureAwait(false);
    }

    public void Dispose()
    {
        _stop.Cancel();
        _listener.Stop();
        _stop.Dispose();
    }
}

/// <summary>A request to <see cref="LoopbackHttp"/>: its method, path, headers (names in lower case) and body.</summary>
internal sealed record LoopbackRequest(string Method, string Path, IReadOnlyDictionary<string, string> Headers, byte[] Body);

/// <summary>An answer from <see cref="LoopbackHttp"/>: its status and JSON body.</summary>
internal sealed record LoopbackResponse(HttpStatusCode Code, string? Json = null)
{
    public static LoopbackResponse Status(HttpStatusCode code) => new(code);
}
