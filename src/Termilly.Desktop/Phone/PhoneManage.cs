namespace Termilly.Desktop.Phone;

/// <summary>
/// What a phone or another computer may ask through the manage op (js/phonemanage.js, js/phonetodo.js): which setting
/// each action needs, and how long the page is given to answer.
/// </summary>
internal static class PhoneManage
{
    /// <summary>Clears notifications: allowed with typing off too.</summary>
    private const string ClearNoteAction = "clearNote";
    private const string OpenAction = "open";
    private const string NewWorkspaceAction = "newWorkspace";
    private const string CloseAction = "close";
    private const string CloseWorkspaceAction = "closeWorkspace";
    /// <summary>Implement opens a terminal and types into it: it needs both.</summary>
    private const string ImplementAction = "taskImplement";
    /// <summary>GitHub can take its time: the actions that wait for it.</summary>
    private static readonly string[] IssueActions = ["issueInfo", "issueCreate"];
    private static readonly TimeSpan IssueWait = TimeSpan.FromSeconds(40);

    /// <summary>The setting that's off and keeps an action from being done, or null. Opening and closing have their own.</summary>
    internal static string? Refused(string? action, PhoneSettings phone) => action switch
    {
        ClearNoteAction => null,
        OpenAction or NewWorkspaceAction => phone.AllowOpening == true ? null : "Allow creating",
        CloseAction or CloseWorkspaceAction => phone.AllowClosing == true ? null : "Allow closing",
        ImplementAction when phone.AllowOpening != true => "Allow creating",
        _ => phone.AllowTyping ? null : "Allow typing",
    };

    /// <summary>How long the page has to answer, when that isn't the usual.</summary>
    internal static TimeSpan? Wait(string? action) => IssueActions.Contains(action) ? IssueWait : null;
}
