namespace Termilly.Desktop.Messaging;

// To do (js/todopanel.js): a GitHub issue made from a task, with the GitHub CLI (Features/Todo.cs).

internal static partial class FromPage
{
    /// <summary>Whether a folder's repository is on GitHub, so an issue can be made from it.</summary>
    internal sealed record TodoRepoCheck(string? Folder = null) : IPageMessage
    {
        public static string Type => "todo:repoCheck";
    }

    /// <summary>The repository of a folder and its labels, for the form that creates an issue.</summary>
    internal sealed record TodoIssueInfo(string? RequestId = null, string? Folder = null) : IPageMessage
    {
        public static string Type => "todo:issueInfo";
    }

    /// <summary>Creates an issue in the repository of <see cref="Folder"/>.</summary>
    internal sealed record TodoIssueCreate(
        string? RequestId = null, string? Folder = null, string Title = "", string Body = "", IReadOnlyList<string>? Labels = null) : IPageMessage
    {
        public static string Type => "todo:issueCreate";
    }
}

internal static partial class ToPage
{
    /// <summary>Whether <see cref="Folder"/>'s repository is on GitHub.</summary>
    internal sealed record TodoRepoChecked(string? Folder, bool OnGitHub) : IHostMessage
    {
        public static string Type => "todo:repoChecked";
    }

    /// <summary>The repository and its labels, or why there's none to use.</summary>
    internal sealed record TodoIssueInfo(string? RequestId, string? Repo, IReadOnlyList<string> Labels, string? Error = null) : IHostMessage
    {
        public static string Type => "todo:issueInfo";
    }

    /// <summary>The issue created, or why it wasn't.</summary>
    internal sealed record TodoIssueCreated(string? RequestId, string? Url, int? Number, string? Error = null) : IHostMessage
    {
        public static string Type => "todo:issueCreated";
    }
}
