using System.Reflection;
using System.Text.Json;
using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Tests;

/// <summary>The page↔host messages (Messaging/): every one reads, and what the host writes is what the page reads.</summary>
public sealed class MessagingTests
{
    private static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web);

    private static IEnumerable<Type> Messages(Type kind) =>
        typeof(IPageMessage).Assembly.GetTypes().Where(t => t.IsClass && kind.IsAssignableFrom(t));

    private static string TypeOf(Type message) => (string)message.GetProperty("Type", BindingFlags.Public | BindingFlags.Static)!.GetValue(null)!;

    [Fact]
    public void Every_page_message_reads_from_an_empty_message()
    {
        var messages = Messages(typeof(IPageMessage)).ToList();
        Assert.True(messages.Count > 90);
        foreach (var message in messages)
        {
            Assert.NotNull(JsonSerializer.Deserialize($"{{\"type\":\"{TypeOf(message)}\"}}", message, Options));
        }
    }

    [Fact]
    public void Each_page_message_type_is_one_record()
    {
        var types = Messages(typeof(IPageMessage)).Select(TypeOf).ToList();
        Assert.Equal(types.Count, types.Distinct().Count());
    }

    [Fact]
    public void The_router_reads_a_message_into_its_record_and_hands_over_the_files()
    {
        var router = new MessageRouter(Options);
        FromPage.Start? started = null;
        IReadOnlyList<string>? handed = null;
        router.On<FromPage.Start>(m => started = m);
        router.On<FromPage.FilesDrop>((_, files) => handed = files);
        using var start = JsonDocument.Parse("""{"type":"start","id":"t1","profile":"pwsh","cols":120,"rows":30,"env":{"A":"1"},"extra":true}""");
        using var drop = JsonDocument.Parse("""{"type":"files:drop","id":"t1"}""");
        using var unknown = JsonDocument.Parse("""{"type":"nobody:listens"}""");

        Assert.True(router.Dispatch(start.RootElement, null));
        Assert.True(router.Dispatch(drop.RootElement, ["C:\\a.txt"]));
        Assert.False(router.Dispatch(unknown.RootElement, null));
        Assert.Equal(("t1", "pwsh", 120, 30, null), (started!.Id, started.Profile, started.Cols, started.Rows, started.Cwd));
        Assert.Equal("1", started.Env!.Value.GetProperty("A").GetString());
        Assert.Equal(["C:\\a.txt"], handed);
    }

    [Fact]
    public void A_message_that_does_not_read_is_dropped_not_thrown()
    {
        var router = new MessageRouter(Options);
        var called = false;
        router.On<FromPage.Resize>(_ => called = true);
        using var bad = JsonDocument.Parse("""{"type":"resize","cols":"wide"}""");

        Assert.True(router.Dispatch(bad.RootElement, null));
        Assert.False(called);
    }

    private static JsonObject Written<T>(T message)
        where T : IHostMessage => JsonNode.Parse(HostMessage.Json(message, Options))!.AsObject();

    [Fact]
    public void The_host_writes_the_type_first_then_the_fields_by_their_page_names()
    {
        Assert.Equal("""{"type":"output","id":"t1","data":"hi"}""", HostMessage.Json(new ToPage.Output("t1", "hi"), Options));
        Assert.Equal("""{"type":"agents:next"}""", HostMessage.Json(new ToPage.AgentsNext(), Options));
        Assert.Equal("""{"type":"busy","id":"t1","busy":true,"name":"npm","interactive":false}""",
            HostMessage.Json(new ToPage.Busy("t1", true, "npm", false), Options));
        Assert.Equal(["fonts", "uiFonts", "boldFonts"], Written(new ToPage.Fonts(["Consolas"], ["Segoe UI"], [])).Select(p => p.Key).Skip(1));
    }

    [Fact]
    public void Variants_of_one_message_write_what_the_page_tells_them_apart_by()
    {
        var hooked = Written(new ToPage.HookedAgent("t1", "working", "PreToolUse", "Bash", null, null, "s1", "ls", null));
        Assert.Equal(("agent", "hooks", "PreToolUse"), (hooked["type"]!.ToString(), hooked["source"]!.ToString(), hooked["event"]!.ToString()));
        Assert.Equal("poll", Written(new ToPage.PolledAgent("t1", "idle", null, null))["source"]!.ToString());

        var failed = Written(new ToPage.SftpUploadFailed("r1", "a.txt", "denied"));
        Assert.Equal((false, "a.txt", "denied"), ((bool)failed["ok"]!, failed["file"]!.ToString(), failed["message"]!.ToString()));
        Assert.True((bool)Written(new ToPage.SftpDone("r1", null))["ok"]!);

        // A stopped recording or log still says path: null, which the page reads as "not recording".
        var stopped = Written(new ToPage.LogStopped("t1"));
        Assert.True(stopped.ContainsKey("path"));
        Assert.Null(stopped["path"]);
        Assert.True(Written(new ToPage.RecFailed("t1", "disk full")).ContainsKey("path"));
        Assert.True((bool)Written(new ToPage.RegeneratedCode("ABCD"))["regenerated"]!);
        Assert.True((bool)Written(new ToPage.UpdateChecking())["checking"]!);
    }

    [Fact]
    public void A_page_call_carries_its_fields_beside_its_type_and_request()
    {
        var call = JsonNode.Parse(new ToPage.PageCall(ToPage.Calls.Api, "r9", new JsonObject { ["method"] = "list", ["args"] = new JsonObject { ["a"] = 1 } }).Json())!;

        Assert.Equal(("api", "r9", "list", 1), (call["type"]!.ToString(), call["requestId"]!.ToString(), call["method"]!.ToString(), (int)call["args"]!["a"]!));
    }
}
