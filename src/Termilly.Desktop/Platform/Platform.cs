using Microsoft.Extensions.DependencyInjection;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Platform;

// What the shared code needs from the system it runs on, each in its own small interface. Windows (WindowsPlatform)
// and Linux (LinuxPlatform) implement them; AddPlatform registers one object for each it implements.

/// <summary>Where the host's messages to the page go: the window's browser engine. Called from any thread.</summary>
internal interface IPageSink
{
    void Send(string json);
}

/// <summary>The window the page is shown in.</summary>
internal interface IAppWindow
{
    /// <summary>A folder handed over on the command line, opened once the page is up.</summary>
    string? StartFolder { get; }

    /// <summary>The window comes to the front (Termilly started again, a notification clicked…).</summary>
    void BringToFront();

    /// <summary>The page's title bar: minimize, maximize, close, drag, resize.</summary>
    void Act(FromPage.Window action);

    /// <summary>
    /// Closes the window, from any thread: when the page's last snapshot is in, or for an update. A close that hasn't
    /// asked for the snapshot yet still asks for it first.
    /// </summary>
    void CloseNow();

    /// <summary>How many terminals need the user, for the taskbar or dock (0: none).</summary>
    void ShowBadge(int count);

    /// <summary>The page reported in (its first terminal is on screen).</summary>
    void PageReady();

}

/// <summary>The system's file dialogs. Each answers null (or nothing) when cancelled.</summary>
internal interface IFileDialogs
{
    Task<string?> PickFolderAsync(string title, string initial);

    /// <summary>Where to export a workspace layout (a .termilly.yml file).</summary>
    Task<string?> PickLayoutToSaveAsync(string fileName);

    Task<string?> PickLayoutToOpenAsync();

    /// <summary>
    /// Files to upload, picked in the host's own dialog (where the page's can't tell their paths). On Windows the
    /// page's file input gives them instead, so this is never asked there.
    /// </summary>
    Task<IReadOnlyList<string>> PickFilesAsync(string title);
}

/// <summary>The file manager and the browser.</summary>
internal interface IDesktopShell
{
    void OpenFolder(string folder);

    /// <summary>Shows a file in the file manager, selected where the file manager can.</summary>
    void RevealFile(string file);

    void OpenUrl(Uri url);
}

/// <summary>The system's notifications.</summary>
internal interface INotifier
{
    /// <summary>A notification was clicked: the terminal it was about.</summary>
    event Action<string>? Clicked;

    void Notify(string terminal, string title, string body);

    void Withdraw(string terminal);
}

/// <summary>What the system tells about processes, for Settings › About and the ports on a terminal's row.</summary>
internal interface ISystemProcesses
{
    /// <summary>The TCP ports each terminal's processes listen on, by terminal id.</summary>
    IReadOnlyDictionary<string, int[]> TerminalPorts(IReadOnlyDictionary<string, int> sessionPids);

    /// <summary>The browser engine's own processes, counted as the app's.</summary>
    bool IsBrowserEngine(ProcessEntry process);
}

/// <summary>Starting the background host when the user signs in (Settings › Workspaces).</summary>
internal interface ISignInStart
{
    void Set(bool wanted, string hostExe);
}

internal static class PlatformServices
{
    /// <summary>Registers <paramref name="platform"/> as each platform interface it implements.</summary>
    public static IServiceCollection AddPlatform(this IServiceCollection services, object platform)
    {
        foreach (var contract in new[] { typeof(IPageSink), typeof(IAppWindow), typeof(IFileDialogs), typeof(IDesktopShell), typeof(INotifier), typeof(ISystemProcesses), typeof(ISignInStart), typeof(ICredentialStore), typeof(ISystemTheme) })
        {
            if (contract.IsInstanceOfType(platform))
            {
                services.AddSingleton(contract, platform);
            }
        }
        return services;
    }
}

/// <summary>Listening sockets matched to terminals through their process trees (both platforms' ports readers).</summary>
internal static class ListeningPorts
{
    /// <summary>The most ports shown on a terminal's row.</summary>
    private const int MaxPerTerminal = 8;

    public static IReadOnlyDictionary<string, int[]> ByTerminal(IEnumerable<(int Pid, int Port)> listening, IReadOnlyDictionary<int, string> owners) =>
        listening.Where(l => owners.ContainsKey(l.Pid)).GroupBy(l => owners[l.Pid])
            .ToDictionary(g => g.Key, g => g.Select(l => l.Port).Distinct().Order().Take(MaxPerTerminal).ToArray());

    /// <summary>
    /// Which terminal each process belongs to: a terminal's shell, and everything started from it, at any depth.
    /// A process whose parent is gone (it outlived the program that started it) belongs to no terminal.
    /// </summary>
    public static Dictionary<int, string> TerminalOwners(IReadOnlyDictionary<string, int> shells, IReadOnlyDictionary<int, int> parents)
    {
        var children = new Dictionary<int, List<int>>();
        foreach (var (pid, parent) in parents)
        {
            if (pid != parent)
            {
                (children.TryGetValue(parent, out var list) ? list : children[parent] = []).Add(pid);
            }
        }
        var owners = new Dictionary<int, string>();
        foreach (var (terminal, shell) in shells)
        {
            var queue = new Queue<int>([shell]);
            while (queue.TryDequeue(out var pid))
            {
                if (!owners.TryAdd(pid, terminal))
                {
                    continue; // already seen (PIDs reused in a loop)
                }
                foreach (var child in children.GetValueOrDefault(pid) ?? [])
                {
                    queue.Enqueue(child);
                }
            }
        }
        return owners;
    }
}

/// <summary>
/// The fonts installed: text fonts for the app font, the monospace ones among them for terminals, and those of them
/// with a real bold face (without one, bold is faked by smearing the regular glyphs, which looks blurry, so terminals
/// draw bold text at normal weight in those fonts).
/// </summary>
internal sealed record InstalledFonts(IReadOnlyList<string> All, IReadOnlyList<string> Monospace, IReadOnlyList<string> RealBold);

/// <summary>The system's light or dark mode, for the "system" theme.</summary>
internal interface ISystemTheme
{
    bool PrefersLight { get; }
}

/// <summary>Reads which fonts are installed (slow: done once, in the background).</summary>
internal interface IFontCatalog
{
    InstalledFonts Read();
}

internal static class DesktopShellExtensions
{
    /// <summary>Shows a file or folder from a terminal in the file manager (selected, for a file); nothing for a path that isn't there.</summary>
    public static void ShowPath(this IDesktopShell desktop, string? path)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            return;
        }
        var full = Environment.ExpandEnvironmentVariables(path.Trim().Trim('"', '\''));
        if (System.IO.Directory.Exists(full))
        {
            desktop.OpenFolder(full);
        }
        else if (System.IO.File.Exists(full))
        {
            desktop.RevealFile(full);
        }
    }
}
