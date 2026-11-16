namespace Termilly.Desktop.Messaging;

internal static partial class FromPage
{
    internal sealed record GitHubStatus(string? RequestId = null, string? Root = null) : IPageMessage
    {
        public static string Type => "github:status";
    }

    internal sealed record GitHubIssues(string? RequestId = null, string? Root = null, string State = "open", string? Search = null) : IPageMessage
    {
        public static string Type => "github:issues";
    }

    internal sealed record GitHubIssue(string? RequestId = null, string? Root = null, int Number = 0) : IPageMessage
    {
        public static string Type => "github:issue";
    }

    internal sealed record GitHubIssueAct(string? RequestId = null, string? Root = null, int Number = 0, string? Action = null, string? Body = null) : IPageMessage
    {
        public static string Type => "github:issueAct";
    }

    internal sealed record GitHubPrFor(string? RequestId = null, string? Root = null, string? Branch = null) : IPageMessage
    {
        public static string Type => "github:prFor";
    }

    internal sealed record GitHubPrCreate(string? RequestId = null, string? Root = null, string? Base = null,
        string? Head = null, string? Title = null, string? Body = null, bool Draft = false) : IPageMessage
    {
        public static string Type => "github:prCreate";
    }
}

internal static partial class ToPage
{
    internal sealed record GitHubResult(string? RequestId, object? Data, string? Error) : IHostMessage
    {
        public static string Type => "github:result";
    }
}
