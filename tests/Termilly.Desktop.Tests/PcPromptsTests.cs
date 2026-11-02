using System.Net;
using System.Text;
using System.Text.Json.Nodes;
using Termilly.Desktop.Phone;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>Prompt history for another Termilly computer (Phone/PcPromptsApi.cs, Features/RemotePcs.cs).</summary>
public sealed class PcPromptsTests
{
    private sealed class Settings(bool share) : ISettingsStore
    {
        public AppSettings Current { get; } = new() { Phone = new PhoneSettings { SharePrompts = share } };
#pragma warning disable CS0067 // never raised here
        public event Action<SettingsSaved>? Saved;
#pragma warning restore CS0067
        public void Save(AppSettings settings) => throw new NotSupportedException();
    }

    [Fact]
    public void Other_computers_may_see_prompt_history_unless_turned_off() =>
        Assert.True(new PhoneSettings().SharePrompts);

    [Fact]
    public async Task Nothing_is_listed_while_prompt_history_is_off_for_other_computers()
    {
        var api = new PcPromptsApi(null!, null!, new Settings(share: false));
        var reply = await api.AnswerAsync(new PhoneRequest("POST", PcPrompts.Path, [], Encoding.UTF8.GetBytes("""{"pane":"t1"}""")));
        Assert.Equal(HttpStatusCode.Conflict, reply.Status);
        Assert.Contains("Prompt history", Encoding.UTF8.GetString(reply.Content), StringComparison.Ordinal);
    }

    [Fact]
    public async Task A_request_without_a_terminal_is_refused()
    {
        var api = new PcPromptsApi(null!, null!, new Settings(share: true));
        var reply = await api.AnswerAsync(new PhoneRequest("POST", PcPrompts.Path, [], Encoding.UTF8.GetBytes("{}")));
        Assert.Equal(HttpStatusCode.BadRequest, reply.Status);
    }

    [Fact]
    public void The_other_computers_answer_is_read_in_order_without_empty_prompts()
    {
        var answer = JsonNode.Parse("""{"prompts":[{"text":"fix the build","at":"2026-11-01T14:05:01Z"},{"text":"","at":"x"},{"text":"ship it","at":"2026-11-01T15:00:00Z"}]}""")!.AsObject();
        var prompts = PcPromptsApi.Read(answer);
        Assert.Equal(["fix the build", "ship it"], prompts.Select(p => p.Text));
        Assert.Equal("2026-11-01T14:05:01Z", prompts[0].At);
    }
}
