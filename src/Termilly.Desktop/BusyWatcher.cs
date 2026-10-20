using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>A process in a snapshot: its id, its parent's id and its executable's file name.</summary>
internal readonly record struct ProcessEntry(int Id, int ParentId, string Exe);

/// <summary>What a terminal is running: a command, or an interactive program waiting on the user (ssh, vim).</summary>
internal readonly record struct ChildProgram(string Name, bool Interactive);

/// <summary>
/// Notices when a terminal is running a command: its shell has a child process (Start-Process -Wait, npm install,
/// a build). Four times a second (and just after Enter) it takes one process snapshot for all terminals and reports
/// changes. Interactive
/// programs (ssh, vim, a nested shell's prompt, Claude Code, which reports its own progress) don't count, or
/// the spinner would never stop.
/// </summary>
internal sealed class BusyWatcher : IDisposable
{
    /// <summary>Console hosts the pseudo console starts, and WSL's host for a distribution; never commands.</summary>
    private static readonly HashSet<string> ConsoleHosts = new(StringComparer.OrdinalIgnoreCase) { "conhost.exe", "OpenConsole.exe", "wslhost.exe" };

    /// <summary>Shells: waiting at their own prompt isn't busy, but a command they run is.</summary>
    private static readonly string[] WindowsShells = ["cmd.exe", "powershell.exe", "pwsh.exe", "bash.exe", "sh.exe"];
    private static readonly string[] UnixShells = ["bash", "sh", "dash", "zsh", "fish", "ksh", "mksh", "tcsh", "csh", "nu", Pwsh, "xonsh"];
    private static readonly HashSet<string> Shells = OperatingSystem.IsWindows()
        ? new(WindowsShells, StringComparer.OrdinalIgnoreCase)
        : new(UnixShells, StringComparer.Ordinal);

    /// <summary>PowerShell off Windows: it gets Termilly's integration too, and marks its own commands.</summary>
    private const string Pwsh = "pwsh";
    /// <summary>A look soon after Enter was typed.</summary>
    private static readonly TimeSpan NudgeDelay = TimeSpan.FromMilliseconds(150);
    /// <summary>About how many processes a system runs: a snapshot's list starts this big.</summary>
    private const int TypicalProcesses = 512;
    /// <summary>Linux's process folders, and each one's status file.</summary>
    private const string ProcFolder = "/proc";
    private const string StatFile = "stat";
    /// <summary>What follows a process's name in its stat file is split into its state, its parent's id and the rest.</summary>
    private const int StatParts = 3;

    /// <summary>Interactive programs, ignored with everything they start: they wait for the user, not the other way round.</summary>
    private static readonly string[] WindowsInteractive = [
        "ssh.exe", "mosh-client.exe", "telnet.exe", "plink.exe", "vim.exe", "nvim.exe", "vi.exe", "nano.exe",
        "less.exe", "more.com", "man.exe", "htop.exe", "claude.exe", "wsl.exe",
    ];
    private static readonly string[] UnixInteractive = [
        "ssh", "mosh-client", "telnet", "vim", "nvim", "vi", "nano", "micro", "emacs", "less", "more", "man",
        "htop", "btop", "top", "mc", "tmux", "screen", AgentExecutables.Claude,
    ];
    private static readonly HashSet<string> Interactive = OperatingSystem.IsWindows()
        ? new(WindowsInteractive, StringComparer.OrdinalIgnoreCase)
        : new(UnixInteractive, StringComparer.Ordinal);

    private readonly Func<IReadOnlyDictionary<string, int>> _roots;
    private readonly Action<string, ChildProgram?> _changed;
    private readonly Timer _timer;
    private readonly Dictionary<string, ChildProgram?> _reported = new();
    private readonly Dictionary<string, ChildProgram?> _pending = new();
    private int _ticking;

    /// <param name="roots">The terminals to watch: id → the pseudo console's root process id.</param>
    /// <param name="changed">Called (on a pool thread) with a terminal's id and what it runs, or null when it went back to its prompt.</param>
    public BusyWatcher(Func<IReadOnlyDictionary<string, int>> roots, Action<string, ChildProgram?> changed)
    {
        _roots = roots;
        _changed = changed;
        _timer = new Timer(_ => Tick(), null, Interval, Interval);
    }

    /// <summary>How often to look; with the two-look rule a command shows as busy within about half a second.</summary>
    private static readonly TimeSpan Interval = TimeSpan.FromMilliseconds(250);

    /// <summary>A key that may start a command (Enter) was typed: look shortly, then keep the usual rhythm.</summary>
    public void Nudge()
    {
        try
        {
            _timer.Change(NudgeDelay, Interval);
        }
        catch (ObjectDisposedException)
        {
            // Turned off (Settings) or closing: nothing to look at.
        }
    }

    public void Dispose() => _timer.Dispose();

    /// <summary>
    /// The program the root process is busy with, or null. The root itself never counts: it is the shell, or the
    /// profile's own command (an ssh profile is ssh).
    /// </summary>
    public static string? BusyChild(IReadOnlyList<ProcessEntry> all, int rootPid) =>
        Running(all, rootPid) is { Interactive: false } busy ? busy.Name : null;

    /// <summary>
    /// What the root process runs: a command (busy), else an interactive program (which, with everything it starts,
    /// isn't busy: it waits for the user), else null. Shell integration needs the interactive one, so `ssh host`
    /// doesn't show as a command running for as long as the session lasts.
    /// </summary>
    public static ChildProgram? Running(IReadOnlyList<ProcessEntry> all, int rootPid)
    {
        var children = all.ToLookup(p => p.ParentId);
        var stack = new Stack<ProcessEntry>(children[rootPid].Where(p => p.Id != rootPid));
        var seen = new HashSet<int> { rootPid };
        // A copy of the terminal's own program is part of it, not something it runs: wsl.exe starts a second wsl.exe.
        var rootExe = all.FirstOrDefault(p => p.Id == rootPid).Exe;
        ChildProgram? interactive = null;
        while (stack.Count > 0)
        {
            var process = stack.Pop();
            if (!seen.Add(process.Id) || ConsoleHosts.Contains(process.Exe))
            {
                continue;
            }
            if (Interactive.Contains(process.Exe) && !string.Equals(process.Exe, rootExe, StringComparison.OrdinalIgnoreCase))
            {
                interactive ??= new ChildProgram(process.Exe, Interactive: true);
                continue;
            }
            if (!Shells.Contains(process.Exe) && !string.Equals(process.Exe, rootExe, StringComparison.OrdinalIgnoreCase))
            {
                return new ChildProgram(process.Exe, Interactive: false);
            }
            // Off Windows, a shell started from the terminal's shell (zsh typed at bash's prompt) waits at its own
            // prompt for the user until it runs something; the outer shell's marks would otherwise show it as a command
            // running. Not pwsh: it gets Termilly's integration there too, and marks its own commands.
            if (!OperatingSystem.IsWindows() && Shells.Contains(process.Exe) && process.Exe != Pwsh &&
                !string.Equals(process.Exe, rootExe, StringComparison.Ordinal) && !children[process.Id].Any())
            {
                interactive ??= new ChildProgram(process.Exe, Interactive: true);
                continue;
            }
            foreach (var child in children[process.Id])
            {
                stack.Push(child);
            }
        }
        return interactive;
    }

    private void Tick()
    {
        // A slow snapshot must not pile up ticks.
        if (Interlocked.Exchange(ref _ticking, 1) == 1)
        {
            return;
        }
        try
        {
            var roots = _roots();
            var snapshot = roots.Count > 0 ? Snapshot() : [];
            foreach (var gone in _reported.Keys.Except(roots.Keys).ToList())
            {
                _reported.Remove(gone);
                _pending.Remove(gone);
            }

            foreach (var (id, pid) in roots)
            {
                var busy = Running(snapshot, pid);
                _reported.TryGetValue(id, out var current);
                if (busy == current)
                {
                    _pending.Remove(id);
                    continue;
                }

                // Report a new state only once it has lasted two looks, so a quick `dir` doesn't flicker.
                if (_pending.TryGetValue(id, out var waiting) && waiting == busy)
                {
                    _pending.Remove(id);
                    _reported[id] = busy;
                    _changed(id, busy);
                }
                else
                {
                    _pending[id] = busy;
                }
            }
        }
        catch (Exception e) when (e is Win32Exception or InvalidOperationException or IOException)
        {
            // A failed snapshot just skips a tick.
        }
        finally
        {
            Volatile.Write(ref _ticking, 0);
        }
    }

    /// <summary>Every process on the machine, from one Toolhelp snapshot (on Linux, from /proc).</summary>
    public static List<ProcessEntry> Snapshot()
    {
        if (!OperatingSystem.IsWindows())
        {
            return ProcSnapshot();
        }
        var handle = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (handle == InvalidHandle)
        {
            throw new Win32Exception();
        }
        try
        {
            var list = new List<ProcessEntry>(TypicalProcesses);
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            for (var ok = Process32FirstW(handle, ref entry); ok; ok = Process32NextW(handle, ref entry))
            {
                list.Add(new ProcessEntry((int)entry.th32ProcessID, (int)entry.th32ParentProcessID, entry.szExeFile));
            }
            return list;
        }
        finally
        {
            CloseHandle(handle);
        }
    }

    /// <summary>
    /// Every process, from /proc/&lt;pid&gt;/stat: "pid (name) state ppid …". The name is the program's (at most 15
    /// characters) and may itself hold spaces and brackets, so it ends at the last ")". Processes that end while
    /// being read are left out.
    /// </summary>
    private static List<ProcessEntry> ProcSnapshot()
    {
        var list = new List<ProcessEntry>(TypicalProcesses);
        foreach (var dir in Directory.EnumerateDirectories(ProcFolder))
        {
            var name = Path.GetFileName(dir);
            if (name.Length == 0 || !char.IsAsciiDigit(name[0]) || !int.TryParse(name, out var pid))
            {
                continue;
            }
            try
            {
                var stat = File.ReadAllText(Path.Combine(dir, StatFile));
                int open = stat.IndexOf('('), close = stat.LastIndexOf(')');
                var rest = stat[(close + 2)..].Split(' ', StatParts); // state, ppid, …
                if (open > 0 && close > open && rest.Length >= 2 && int.TryParse(rest[1], out var ppid))
                {
                    list.Add(new ProcessEntry(pid, ppid, stat[(open + 1)..close]));
                }
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is ArgumentOutOfRangeException)
            {
            }
        }
        return list;
    }

    private const uint TH32CS_SNAPPROCESS = 0x2;
    private static readonly IntPtr InvalidHandle = new(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32FirstW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool Process32NextW(IntPtr snapshot, ref PROCESSENTRY32W entry);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
}
