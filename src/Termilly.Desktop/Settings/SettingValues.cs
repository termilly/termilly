namespace Termilly.Desktop;

/// <summary>
/// The values each setting with a fixed set of them can take, as saved in settings.json and as the page's Settings
/// offers them (js/settings.js). <c>All</c> is what <see cref="AppSettings.Normalize"/> accepts; anything else
/// becomes <c>Default</c>.
/// </summary>
internal static class SettingValues
{
    /// <summary>The colour theme: these, or one of js/themes.js's ids (a plugin's too).</summary>
    public static class Theme
    {
        public const string Dark = "dark";
        public const string Light = "light";
        /// <summary>Follow the system's light or dark mode.</summary>
        public const string System = "system";
        public const string Default = Dark;
    }

    public static class CursorStyle
    {
        public const string Bar = "bar";
        public const string Block = "block";
        public const string Underline = "underline";
        public const string Default = Bar;
        public static readonly IReadOnlyList<string> All = [Bar, Block, Underline];
    }

    /// <summary>
    /// How terminal text is anti-aliased. ClearType's coloured fringes make coloured text (prompts, ls --color) look
    /// blurry on a dark background, so greyscale is the default.
    /// </summary>
    public static class TextSmoothing
    {
        public const string Grayscale = "grayscale";
        public const string ClearType = "cleartype";
        public const string Default = Grayscale;
        public static readonly IReadOnlyList<string> All = [Grayscale, ClearType];
    }

    /// <summary>How many days of closed terminals' history are kept.</summary>
    public static class HistoryDays
    {
        public const int Default = 30;
        public static readonly IReadOnlyList<int> All = [7, Default, 90, 365];
    }

    /// <summary>What the window's Minimize does: the taskbar, or the tray (Windows, TrayIcon.cs).</summary>
    public static class MinimizeTo
    {
        public const string Taskbar = "taskbar";
        public const string Tray = "tray";
        public const string Default = Taskbar;
        public static readonly IReadOnlyList<string> All = [Taskbar, Tray];
    }

    /// <summary>What the window's Close does: quit Termilly, or keep it running in the tray (Windows, TrayIcon.cs).</summary>
    public static class CloseAction
    {
        public const string Quit = "quit";
        public const string Tray = "tray";
        public const string Default = Quit;
        public static readonly IReadOnlyList<string> All = [Quit, Tray];
    }

    /// <summary>Scrollback for terminals in workspaces out of sight: 0 keeps the normal amount.</summary>
    public static class HiddenScrollback
    {
        public const int Default = 0;
        public static readonly IReadOnlyList<int> All = [Default, 5_000, 1_000];
    }

    /// <summary>At start: terminals with their last output and command, the layout alone, or a fresh workspace.</summary>
    public static class RestoreSession
    {
        public const string Scrollback = "scrollback";
        public const string Layout = "layout";
        public const string Off = "off";
        public const string Default = Scrollback;
        public static readonly IReadOnlyList<string> All = [Scrollback, Layout, Off];
    }

    /// <summary>Claude Code sessions kept running before idle ones hibernate (js/hibernate.js); 0: no limit.</summary>
    public static class AgentLimit
    {
        public const int Default = 12;
        public static readonly IReadOnlyList<int> All = [0, 4, 8, Default];
    }

    /// <summary>Terminal logs: plain text (escape codes stripped, commands marked) or raw.</summary>
    public static class LogFormat
    {
        public const string Plain = "plain";
        public const string Raw = "raw";
        public const string Default = Plain;
    }

    /// <summary>When pasting into a production terminal asks first (js/environments.js decides; the host only keeps it).</summary>
    public static class ProdPaste
    {
        public const string Always = "always";
        /// <summary>Several lines, or one with a risky word.</summary>
        public const string Multiline = "multiline";
        /// <summary>A line with a risky word (rm, drop, delete).</summary>
        public const string Dangerous = "dangerous";
        public const string Never = "never";
        public const string Default = Always;
    }

    /// <summary>The sidebar's agent activity line: everywhere, in the workspace on screen only, or nowhere.</summary>
    public static class AgentLine
    {
        public const string On = "on";
        public const string Focused = "focused";
        public const string Off = "off";
        public const string Default = On;
    }

    /// <summary>What an agent's use shows as: dollars, tokens, or nothing.</summary>
    public static class CostDisplay
    {
        public const string Cost = "cost";
        public const string Tokens = "tokens";
        public const string Off = "off";
        public const string Default = Cost;
    }

    /// <summary>The change preview (Changes/, js/preview.js): where it opens.</summary>
    public static class ChangePlacement
    {
        public const string Split = "split";
        public const string Panel = "panel";
        public const string Float = "float";
        public const string Default = Split;
        public static readonly IReadOnlyList<string> All = [Split, Panel, Float];
    }

    /// <summary>
    /// What the change preview compares with: path, Termilly copies the file before Claude edits it; git, the file
    /// against HEAD; full, Claude's edits themselves are sent and replayed.
    /// </summary>
    public static class ChangeSource
    {
        public const string Path = "path";
        public const string Git = "git";
        public const string FullEdits = "full";
        public const string Default = Path;
        public static readonly IReadOnlyList<string> All = [Path, Git, FullEdits];
    }

    public static class ChangeView
    {
        public const string Diff = "diff";
        public const string File = "file";
        public const string DiffOnly = "diffOnly";
        public const string Default = Diff;
        public static readonly IReadOnlyList<string> All = [Diff, File, DiffOnly];
    }

    /// <summary>Compare with the copy from before Claude's first edit in the list, or its last.</summary>
    public static class ChangeCompare
    {
        public const string Session = "session";
        public const string LastEdit = "last";
        public const string Default = Session;
        public static readonly IReadOnlyList<string> All = [Session, LastEdit];
    }

    /// <summary>When Claude changes another file while the preview is open: offer it, or switch to it.</summary>
    public static class ChangeFollow
    {
        public const string Offer = "offer";
        public const string Follow = "follow";
        public const string Default = Offer;
        public static readonly IReadOnlyList<string> All = [Offer, Follow];
    }

    /// <summary>A terminal's list of changes is kept until cleared (or the terminal closes), or per Claude session too.</summary>
    public static class ChangeKeep
    {
        public const string Terminal = "terminal";
        public const string PerSession = "session";
        public const string Default = Terminal;
        public static readonly IReadOnlyList<string> All = [Terminal, PerSession];
    }

    /// <summary>A file Claude created opens as the file itself, or as a diff with every line added.</summary>
    public static class ChangeNewFile
    {
        public const string File = "file";
        public const string Diff = "diff";
        public const string Default = File;
        public static readonly IReadOnlyList<string> All = [File, Diff];
    }

    /// <summary>Lines of context around a change.</summary>
    public static class ChangeContext
    {
        public const int Default = 3;
        public static readonly IReadOnlyList<int> All = [Default, 10, 25];
    }

    /// <summary>The largest file the preview copies and shows, in KB.</summary>
    public static class ChangeMaxFileKb
    {
        public const int Default = 2048;
        public static readonly IReadOnlyList<int> All = [512, Default, 8192];
    }

    public static class ChangeLayout
    {
        public const string Inline = "inline";
        public const string SideBySide = "sideBySide";
        public const string Default = Inline;
        public static readonly IReadOnlyList<string> All = [Inline, SideBySide];
    }

    /// <summary>What a trigger does with a line that matches (js/triggers.js).</summary>
    public static class TriggerAction
    {
        public const string Highlight = "highlight";
        /// <summary>Highlight, and keep it in the captured-lines panel.</summary>
        public const string Capture = "capture";
        public const string Notify = "notify";
        public const string Attention = "attention";
        public const string Default = Highlight;
        public static readonly IReadOnlyList<string> All = [Highlight, Capture, Notify, Attention];
    }

    /// <summary>Which terminals a trigger watches: all, tag:&lt;name&gt; or profile:&lt;id&gt;.</summary>
    public static class TriggerScope
    {
        public const string All = "all";
        public const string TagPrefix = "tag:";
        public const string ProfilePrefix = "profile:";
        public const string Default = All;

        public static bool IsValid(string? scope) =>
            scope is All || scope?.StartsWith(TagPrefix, StringComparison.Ordinal) == true || scope?.StartsWith(ProfilePrefix, StringComparison.Ordinal) == true;
    }

    /// <summary>The badge a custom shell shows.</summary>
    public static class ProfileIcon
    {
        public const string Default = ProfileIcons.Custom;
        public static readonly IReadOnlyList<string> All =
            [ProfileIcons.Custom, ProfileIcons.PowerShell, ProfileIcons.Cmd, ProfileIcons.Bash, ProfileIcons.Wsl, ProfileIcons.Ssh];
    }
}
