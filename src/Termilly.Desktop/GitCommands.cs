namespace Termilly.Desktop;

/// <summary>
/// git's own words as Termilly runs it (GitView, GitStatus, Worktrees, the change preview's HEAD copies): the
/// program, its subcommands, the options used in more than one place and the names of refs and files.
/// </summary>
internal static class GitCommands
{
    public const string Program = "git";
    /// <summary>A repository's own folder (a file in a worktree).</summary>
    public const string DotGit = ".git";
    public const string GitIgnore = ".gitignore";
    public const string Head = "HEAD";

    public const string Status = "status";
    public const string Log = "log";
    public const string Show = "show";
    public const string Grep = "grep";
    public const string CatFile = "cat-file";
    public const string DiffTree = "diff-tree";
    public const string ForEachRef = "for-each-ref";
    public const string RevParse = "rev-parse";
    public const string RevList = "rev-list";
    public const string Add = "add";
    public const string Restore = "restore";
    public const string Remove = "rm";
    public const string Clean = "clean";
    public const string Switch = "switch";
    public const string Worktree = "worktree";
    public const string Branch = "branch";

    /// <summary>The options used in more than one place.</summary>
    public static class Options
    {
        /// <summary>What follows is a path, never an option.</summary>
        public const string Paths = "--";
        /// <summary>What follows is a ref or hash, never an option.</summary>
        public const string EndOfOptions = "--end-of-options";
        public const string NulTerminated = "-z";
        public const string Quiet = "-q";
        public const string Force = "--force";
        public const string Staged = "--staged";
        public const string ShowTopLevel = "--show-toplevel";
        /// <summary>git status's machine-readable format, with the branch lines first.</summary>
        public const string PorcelainV2 = "--porcelain=v2";
        public const string WithBranch = "--branch";
        /// <summary>Only the size (cat-file), or no diff (show).</summary>
        public const string SizeOnly = "-s";
        public const string NoOptionalLocks = "--no-optional-locks";
    }

    /// <summary>Where branches live among the refs.</summary>
    public static class Refs
    {
        public const string Heads = "refs/heads";
        public const string Remotes = "refs/remotes";
        public const string Tags = "refs/tags";
        public const string HeadsPrefix = Heads + "/";
        public const string RemotesPrefix = Remotes + "/";
        public const string TagsPrefix = Tags + "/";
    }

    /// <summary>A blob by its rev:path name: "HEAD:src/a.cs", ":src/a.cs" (the index), "&lt;hash&gt;:src/a.cs".</summary>
    public static string Object(string revision, string path) => $"{revision}:{path}";
}

/// <summary>What the Git window's menus do to a file or branch (js/gitwindow.js sends these; GitView.Act does them).</summary>
internal static class GitActions
{
    public const string Stage = "stage";
    public const string Unstage = "unstage";
    public const string Discard = "discard";
    public const string DiscardAll = "discard-all";
    public const string Delete = "delete";
    public const string Ignore = "ignore";
    public const string Switch = "switch";
}

/// <summary>Which change of a file the Git window shows (GitView.Diff).</summary>
internal static class DiffSides
{
    /// <summary>The last commit against the index.</summary>
    public const string Staged = "staged";
    /// <summary>The index against the disk.</summary>
    public const string Unstaged = "unstaged";
    /// <summary>A new file git doesn't know.</summary>
    public const string Untracked = "untracked";
    /// <summary>A commit's first parent against it.</summary>
    public const string Commit = "commit";
}
