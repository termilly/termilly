using System.IO;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

/// <summary>
/// Reads Claude Code's command rules for the page and carries them over to Codex, for the project, when the user says so
/// (AgentRules.cs, js/agentrules.js). Nothing is written until then, and only what the user was shown: should the
/// settings have changed since, nothing is written and they're asked to look again. The files are read off the page's
/// message thread.
/// </summary>
internal sealed class AgentRulesHandler(PageChannel page) : IMessageHandler
{
    private const string Changed = "Claude Code’s settings changed while this was open. Open it again to see what would be copied now.";
    private const string NoProject = "There’s no project folder here to keep Codex’s rules in.";

    public void Register(MessageRouter router)
    {
        router.On<FromPage.AgentRulesRead>(ReadAsync);
        router.On<FromPage.AgentRulesCopy>(CopyAsync);
    }

    private static AgentRules.Plan PlanFor(string? folder) => AgentRules.Read(folder, ClaudeCodeFiles.ConfigDirectory());

    /// <summary>A rule's command as the page shows it and sends it back: its words with spaces between.</summary>
    private static string? CommandOf(AgentRules.Rule rule) => rule.Prefix is null ? null : string.Join(' ', rule.Prefix);

    private async Task ReadAsync(FromPage.AgentRulesRead message)
    {
        var plan = await Task.Run(() => PlanFor(message.Folder)).ConfigureAwait(false);
        page.Post(new ToPage.AgentRulesList(message.Folder, plan.Rules.Select(r => new AgentRuleView(r.Text, r.Decision, r.Source, CommandOf(r), r.Why)).ToList(), plan.File, plan.Existing));
    }

    private async Task CopyAsync(FromPage.AgentRulesCopy message)
    {
        string? file = null;
        try
        {
            var written = await Task.Run(() =>
            {
                var plan = PlanFor(message.Folder);
                file = plan.File;
                var carried = plan.Rules.Where(r => r.Prefix is not null).ToList();
                return file is not null && SameAsShown(carried, message.Rules ?? []) ? AgentRules.Write(carried, file) : (int?)null;
            }).ConfigureAwait(false);
            page.Post(written is { } count ? new ToPage.AgentRulesCopied(count, file) : new ToPage.AgentRulesCopied(0, file, file is null ? NoProject : Changed));
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            page.Post(new ToPage.AgentRulesCopied(0, file, e.Message));
        }
    }

    /// <summary>Whether the rules that would be written are exactly the ones the user was shown and said yes to.</summary>
    internal static bool SameAsShown(IReadOnlyList<AgentRules.Rule> carried, IReadOnlyList<AgentRuleChoice> shown) =>
        carried.Select(r => (r.Text, r.Decision, CommandOf(r))).ToHashSet().SetEquals(shown.Select(s => (s.Text, s.Decision, (string?)s.Command)));
}
