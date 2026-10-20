using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Termilly.Pty.Windows;

internal static class Native
{
    internal const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000;
    internal const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    internal const int STARTF_USESTDHANDLES = 0x00000100;
    internal static readonly IntPtr PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016;

    [StructLayout(LayoutKind.Sequential)]
    internal struct COORD
    {
        public short X;
        public short Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct STARTUPINFOEX
    {
        public STARTUPINFO StartupInfo;
        public IntPtr lpAttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public int dwProcessId;
        public int dwThreadId;
    }

    // ---- Pseudo console: the bundled ConPTY (conpty\conpty.dll + OpenConsole.exe) when it loads, else Windows' own ----

    /// <summary>The bundled conpty.dll, next to the app (copied there by Termilly.Pty.csproj).</summary>
    private static readonly string BundledConpty = Path.Combine(AppContext.BaseDirectory, "conpty", "conpty.dll");

    /// <summary>True when terminals run on the bundled ConPTY rather than the console host built into Windows.</summary>
    public static bool UsesBundledConpty { get; } = LoadBundledConpty();

    private static bool LoadBundledConpty()
    {
        if (!File.Exists(BundledConpty) || !NativeLibrary.TryLoad(BundledConpty, out var handle))
        {
            return false;
        }
        NativeLibrary.SetDllImportResolver(typeof(Native).Assembly, (name, _, _) => name == "conpty.dll" ? handle : IntPtr.Zero);
        return true;
    }

    internal static int CreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC) =>
        UsesBundledConpty
            ? ConptyCreatePseudoConsole(size, hInput, hOutput, dwFlags, out phPC)
            : InboxCreatePseudoConsole(size, hInput, hOutput, dwFlags, out phPC);

    internal static int ResizePseudoConsole(IntPtr hPC, COORD size) =>
        UsesBundledConpty ? ConptyResizePseudoConsole(hPC, size) : InboxResizePseudoConsole(hPC, size);

    internal static void ClosePseudoConsole(IntPtr hPC)
    {
        if (UsesBundledConpty)
        {
            ConptyClosePseudoConsole(hPC);
        }
        else
        {
            InboxClosePseudoConsole(hPC);
        }
    }

    [DllImport("conpty.dll", SetLastError = true)]
    private static extern int ConptyCreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("conpty.dll", SetLastError = true)]
    private static extern int ConptyResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("conpty.dll", SetLastError = true)]
    private static extern void ConptyClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "CreatePseudoConsole")]
    private static extern int InboxCreatePseudoConsole(COORD size, SafeFileHandle hInput, SafeFileHandle hOutput, uint dwFlags, out IntPtr phPC);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ResizePseudoConsole")]
    private static extern int InboxResizePseudoConsole(IntPtr hPC, COORD size);

    [DllImport("kernel32.dll", SetLastError = true, EntryPoint = "ClosePseudoConsole")]
    private static extern void InboxClosePseudoConsole(IntPtr hPC);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CreatePipe(out SafeFileHandle hReadPipe, out SafeFileHandle hWritePipe, IntPtr lpPipeAttributes, int nSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool InitializeProcThreadAttributeList(IntPtr lpAttributeList, int dwAttributeCount, int dwFlags, ref IntPtr lpSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool UpdateProcThreadAttribute(IntPtr lpAttributeList, uint dwFlags, IntPtr attribute, IntPtr lpValue, IntPtr cbSize, IntPtr lpPreviousValue, IntPtr lpReturnSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern void DeleteProcThreadAttributeList(IntPtr lpAttributeList);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool SetConsoleCtrlHandler(IntPtr handler, bool add);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    internal static extern bool CreateProcess(
        string? lpApplicationName,
        char[] lpCommandLine,
        IntPtr lpProcessAttributes,
        IntPtr lpThreadAttributes,
        bool bInheritHandles,
        uint dwCreationFlags,
        IntPtr lpEnvironment,
        string? lpCurrentDirectory,
        ref STARTUPINFOEX lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool GetExitCodeProcess(SafeWaitHandle hProcess, out int lpExitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    internal static extern bool CloseHandle(IntPtr hObject);
}
