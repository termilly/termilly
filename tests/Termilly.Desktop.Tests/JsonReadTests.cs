using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Services;
using Termilly.Shared;

namespace Termilly.Desktop.Tests;

/// <summary>Reading typed values from JSON that came from elsewhere (Shared/JsonRead.cs): a wrong type is null, never a throw.</summary>
public sealed class JsonReadTests
{
    private static JsonNode? Field(string json) => JsonNode.Parse(json)!["x"];

    [Fact]
    public void Each_reader_takes_its_own_type()
    {
        Assert.Equal("hi", Field("""{"x":"hi"}""").AsText());
        Assert.True(Field("""{"x":true}""").AsBool());
        Assert.Equal(9_000_000_000L, Field("""{"x":9000000000}""").AsLong());
        Assert.Equal(42, Field("""{"x":42}""").AsInt());
        Assert.Equal(7L, JsonValue.Create(7).AsLong()); // made in memory as an int
    }

    [Theory]
    [InlineData("""{"x":5}""")]
    [InlineData("""{"x":{"a":1}}""")]
    [InlineData("""{"x":[1]}""")]
    [InlineData("""{"x":null}""")]
    [InlineData("""{}""")]
    public void A_wrong_type_or_none_is_null_for_text(string json) => Assert.Null(Field(json).AsText());

    [Theory]
    [InlineData("""{"x":"true"}""")]
    [InlineData("""{"x":1}""")]
    [InlineData("""{"x":{}}""")]
    public void A_wrong_type_is_null_for_a_flag(string json) => Assert.Null(Field(json).AsBool());

    [Theory]
    [InlineData("""{"x":"5"}""")]
    [InlineData("""{"x":1.5}""")]
    [InlineData("""{"x":9000000000}""")] // past an int
    [InlineData("""{"x":[]}""")]
    public void A_wrong_type_or_size_is_null_for_an_int(string json) => Assert.Null(Field(json).AsInt());

    [Fact]
    public void Another_computers_answer_is_done_only_when_it_says_ok_true()
    {
        static string? Error(string json) => Termilly.Desktop.Features.RemotePcsHandler.ErrorOf(JsonNode.Parse(json)!.AsObject());
        Assert.Null(Error("""{"ok":true}"""));
        Assert.Equal("off here", Error("""{"ok":false,"error":"off here"}"""));
        foreach (var garbled in new[] { """{}""", """{"ok":null}""", """{"ok":"true"}""", """{"ok":1}""", """{"ok":{}}""", """{"ok":[true]}""" })
        {
            Assert.Equal("That didn’t go through.", Error(garbled));
        }
        Assert.Equal("That didn’t go through.", Error("""{"ok":false,"error":5}""")); // an error that isn't text
    }

    private sealed class Settings : ISettingsStore
    {
        public AppSettings Current { get; } = new() { Phone = new PhoneSettings { AllowTyping = true } };
#pragma warning disable CS0067 // never raised here
        public event Action<SettingsSaved>? Saved;
#pragma warning restore CS0067
        public void Save(AppSettings settings) => throw new NotSupportedException();
    }

    [Theory]
    [InlineData("""{"pane":5,"path":"C:\\"}""")]
    [InlineData("""{"pane":{"a":1}}""")]
    [InlineData("""{"pane":["t1"]}""")]
    public void A_files_request_with_a_wrongly_typed_field_is_a_bad_request_not_a_fault(string body)
    {
        var api = new PcFilesApi(null!, new Settings());
        var reply = api.Answer(new PhoneRequest("POST", PcFiles.List, [], Encoding.UTF8.GetBytes(body)));
        Assert.Equal(HttpStatusCode.BadRequest, reply.Status);
    }
}
