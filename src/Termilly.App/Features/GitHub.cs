using System.Text.Json;
using Termilly.Desktop.Messaging;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Features;

internal sealed class GitHubHandler(PageChannel page, IGitHub github) : IMessageHandler
{
    public void Register(MessageRouter router)
    {
        RegisterChecks(router);
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

    private void RegisterChecks(MessageRouter router)
    {
        router.On<FromPage.GitHubRuns>(m => Answer(m.RequestId, () => github.Runs(LocalRoot(m.Remote, m.Root), m.Branch)));
        router.On<FromPage.GitHubRunJobs>(m => Answer(m.RequestId, () => github.RunJobs(LocalRoot(m.Remote, m.Root), m.RunId)));
        router.On<FromPage.GitHubFailedLog>(m => Answer(m.RequestId, () => github.FailedLog(LocalRoot(m.Remote, m.Root), m.RunId, m.JobId)));
        router.On<FromPage.GitHubRerunFailed>(m => Answer(m.RequestId, () =>
        {
            github.RerunFailed(LocalRoot(m.Remote, m.Root), m.RunId);
            return null;
        }));
    }

    private static string LocalRoot(string? remote, string? root) => remote is null ? root ?? "" : throw new ArgumentException("GitHub checks work on this computer's repositories.");

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
