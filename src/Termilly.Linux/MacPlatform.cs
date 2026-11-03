using System.Security;
using Termilly.Desktop;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// What macOS does for the shared code (Platform/): open for the Finder and the browser, the Trash through trash,
/// notifications through osascript, the ports terminals listen on from lsof, and the background host started at
/// sign-in by a launch agent. The window and its dialogs are <see cref="PhotinoPlatform"/>'s (Cocoa, through Photino).
/// </summary>
internal sealed class MacPlatform(Action<string> send, string? startFolder, IProcessRunner runner) :
    PhotinoPlatform(send, startFolder), IDesktopShell, INotifier, ISystemProcesses, ISignInStart, ISystemTheme
{
    /// <summary>Opens a folder, file or link with what the system chose for it; with -R, shows a file in the Finder.</summary>
    private const string Open = "open";
    private const string RevealOption = "-R";
    /// <summary>The Trash's command (macOS 15 and later).</summary>
    private const string TrashCommand = "/usr/bin/trash";
    private const string DownloadsName = "Downloads";
    /// <summary>What the browser engine's processes are called (WebKit's XPC services; the name is cut at 16 characters).</summary>
    private const string BrowserEngine = "com.apple.WebKit";
    /// <summary>The system's appearance: AppleInterfaceStyle is "Dark" in dark mode and missing in light mode.</summary>
    private const string DarkStyle = "Dark";
    /// <summary>The launch agent's label and file, in ~/Library/LaunchAgents.</summary>
    private const string AgentLabel = "com.termilly.host";
    /// <summary>osascript's script, a line per -e, taking the title and the body as its arguments.</summary>
    private static readonly string[] NotifyScript =
        ["-e", "on run argv", "-e", "display notification (item 2 of argv) with title (item 1 of argv)", "-e", "end run"];

    private readonly MacPorts _ports = new(runner);

    public bool PrefersLight => Query("defaults", "read", "-g", "AppleInterfaceStyle") is not { } style ||
                                !style.Contains(DarkStyle, StringComparison.OrdinalIgnoreCase);

    /// <summary>osascript's notifications can't be clicked through to a terminal, so this never fires.</summary>
    public event Action<string>? Clicked
    {
        add { }
        remove { }
    }

    // ---- The Finder and the browser ----

    public void OpenFolder(string folder) => Run(Open, folder);

    public void RevealFile(string file) => Run(Open, RevealOption, file);

    public void OpenFile(string file) => Run(Open, file);

    public void OpenUrl(Uri url) => Run(Open, url.AbsoluteUri);

    /// <summary>The Trash, as the Finder's Move to Trash does (it can be put back from there). The path is made full so it can't read as an option.</summary>
    public void Trash(string path)
    {
        try
        {
            RunToEnd(TrashCommand, $"Couldn't move {Path.GetFileName(path)} to the Trash.", Path.GetFullPath(path));
        }
        catch (System.ComponentModel.Win32Exception)
        {
            throw new IOException("Moving to the Trash needs macOS 15 or later.");
        }
    }

    /// <summary>macOS doesn't let the Downloads folder move; it's always ~/Downloads.</summary>
    public string DownloadsFolder => Path.Combine(Home, DownloadsName);

    // ---- Notifications ----

    /// <summary>The title and body go to the script as arguments, never into its text, so nothing in them can run.</summary>
    public void Notify(string terminal, string title, string body) =>
        Run("osascript", [.. NotifyScript, title, body]);

    /// <summary>osascript's notifications can't be taken back.</summary>
    public void Withdraw(string terminal)
    {
    }

    // ---- Processes ----

    public IReadOnlyDictionary<string, int[]> TerminalPorts(IReadOnlyDictionary<string, int> sessionPids) =>
        ListeningPorts.ByTerminal(_ports.Listening(), ListeningPorts.TerminalOwners(sessionPids, MacPorts.ParentIds()));

    public bool IsBrowserEngine(ProcessEntry process) => process.Exe.StartsWith(BrowserEngine, StringComparison.Ordinal);

    // ---- Sign-in ----

    /// <summary>
    /// Starts the background host at sign-in, or stops doing so: a launch agent in ~/Library/LaunchAgents, which
    /// launchd runs when the user signs in.
    /// </summary>
    public void Set(bool wanted, string hostExe)
    {
        var agent = Path.Combine(Home, "Library", "LaunchAgents", AgentLabel + ".plist");
        try
        {
            if (wanted)
            {
                var text = LaunchAgent(hostExe);
                if (!File.Exists(agent) || File.ReadAllText(agent) != text)
                {
                    AppPaths.WriteAtomically(agent, text);
                }
            }
            else if (File.Exists(agent))
            {
                File.Delete(agent);
            }
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // Left as it was; Settings still shows the choice.
        }
    }

    /// <summary>The launch agent's property list: the host, started once at sign-in and not again when it ends.</summary>
    internal static string LaunchAgent(string hostExe) => $"""
        <?xml version="1.0" encoding="UTF-8"?>
        <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
        <plist version="1.0">
        <dict>
            <key>Label</key>
            <string>{AgentLabel}</string>
            <key>ProgramArguments</key>
            <array>
                <string>{SecurityElement.Escape(hostExe)}</string>
            </array>
            <key>RunAtLoad</key>
            <true/>
        </dict>
        </plist>

        """;
}
