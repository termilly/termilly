using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

internal sealed class GitHubHandler(PageChannel page, IGitHub github) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        router.On<FromPage.GitHubStatus>(m => Answer(m.RequestId, () => github.Status(m.Root ?? "")));
        router.On<FromPage.GitHubIssues>(m => Answer(m.RequestId, () => github.Issues(m.Root ?? "", m.State, m.Search)));
        router.On<FromPage.GitHubIssue>(m => Answer(m.RequestId, () => github.Issue(m.Root ?? "", m.Number)));
        router.On<FromPage.GitHubIssueAct>(m => Answer(m.RequestId, () =>
        {
            github.IssueAct(m.Root ?? "", m.Number, m.Action, m.Body);
            return null;
        }));
        router.On<FromPage.GitHubPrFor>(m => Answer(m.RequestId, () => github.PrFor(m.Root ?? "", m.Branch)));
        router.On<FromPage.GitHubPrCreate>(m => Answer(m.RequestId, () => github.PrCreate(m.Root ?? "", m)));
    }

    private void Answer(string? requestId, Func<object?> work) => _ = Task.Run(() =>
    {
        object? data = null;
        string? error = null;
        try
        {
            data = work();
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentException or InvalidOperationException or JsonException)
        {
            error = e.Message;
        }
        page.Post(new ToPage.GitHubResult(requestId, data, error));
    });
}
