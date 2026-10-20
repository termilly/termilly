using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>The real services, for tests that run git and other programs on this machine.</summary>
internal static class TestServices
{
    public static readonly ProcessRunner Runner = new();
    public static readonly LocalGit Git = new(Runner);
    public static readonly LocalGitRunner GitRunner = new(Runner);
    public static readonly Worktrees Worktrees = new(Git);

    /// <summary>
    /// A change store and its preview, whose copies before a command aren't cut short by a slow machine (CI, a busy
    /// run).
    /// </summary>
    public static (ChangeStore Store, ChangePreview Preview) Changes(long maxTotalBytes = ChangeStore.DefaultMaxTotalBytes)
    {
        var store = new ChangeStore(maxTotalBytes, copyTime: TimeSpan.FromSeconds(30));
        return (store, new ChangePreview(store, Git));
    }
}
