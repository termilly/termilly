using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;
using static Termilly.Pty.Windows.Native;

namespace Termilly.Pty.Windows;

/// <summary>Windows pseudo console (ConPTY) backed <see cref="IPty"/>.</summary>
[SupportedOSPlatform("windows")]
public sealed class ConPty : IPty
{
    private readonly SafeWaitHandle _process;
    private readonly RegisteredWaitHandle _exitWait;
    private readonly TaskCompletionSource<int> _exited = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private IntPtr _pseudoConsole;

    private ConPty(IntPtr pseudoConsole, PROCESS_INFORMATION pi, FileStream input, FileStream output)
    {
        _pseudoConsole = pseudoConsole;
        _process = new SafeWaitHandle(pi.hProcess, ownsHandle: true);
        ProcessId = pi.dwProcessId;
        Input = input;
        Output = output;
        _exitWait = ThreadPool.RegisterWaitForSingleObject(
            new ProcessWaitHandle(_process), (_, _) => OnProcessExited(), null, Timeout.Infinite, executeOnlyOnce: true);
    }

    public int ProcessId { get; }
    public Stream Input { get; }
    public Stream Output { get; }
    public Task<int> Exited => _exited.Task;

    /// <summary>
    /// Whether Ctrl+C is turned off for this process is inherited by every process it starts. A parent that turned it
    /// off (a script starting Termilly in the background, say) would leave Ctrl+C unable to stop anything in
    /// Termilly's terminals, so it's turned back on once, before the first shell starts.
    /// </summary>
    private static readonly bool CtrlCRestored = SetConsoleCtrlHandler(IntPtr.Zero, false);

    public static ConPty Start(PtyOptions options)
    {
        _ = CtrlCRestored;
        if (!CreatePipe(out var inputRead, out var inputWrite, IntPtr.Zero, 0) ||
            !CreatePipe(out var outputRead, out var outputWrite, IntPtr.Zero, 0))
        {
            throw new Win32Exception();
        }

        var hr = CreatePseudoConsole(ToCoord(options.Columns, options.Rows), inputRead, outputWrite, 0, out var hpc);
        if (hr != 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }

        try
        {
            var pi = StartProcess(options, hpc);
            CloseHandle(pi.hThread);
            return new ConPty(hpc, pi, new FileStream(inputWrite, FileAccess.Write, 1), new FileStream(outputRead, FileAccess.Read, 1));
        }
        catch
        {
            ClosePseudoConsole(hpc);
            inputWrite.Dispose();
            outputRead.Dispose();
            throw;
        }
        finally
        {
            // The pseudo console holds its own copies; ours must close or Output never reaches EOF.
            inputRead.Dispose();
            outputWrite.Dispose();
        }
    }

    /// <summary>Starts the command line attached to the pseudo console, in its folder and with its variables.</summary>
    private static PROCESS_INFORMATION StartProcess(PtyOptions options, IntPtr hpc)
    {
        var attrSize = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref attrSize);
        var attrList = Marshal.AllocHGlobal(attrSize);
        // Zero inherits this process's environment as is.
        var environment = options.Environment is { Count: > 0 } extra
            ? Marshal.StringToHGlobalUni(EnvironmentBlock.Build(extra))
            : IntPtr.Zero;
        try
        {
            if (!InitializeProcThreadAttributeList(attrList, 1, 0, ref attrSize) ||
                !UpdateProcThreadAttribute(attrList, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE, hpc, IntPtr.Size, IntPtr.Zero, IntPtr.Zero))
            {
                throw new Win32Exception();
            }

            var si = new STARTUPINFOEX { lpAttributeList = attrList };
            si.StartupInfo.cb = Marshal.SizeOf<STARTUPINFOEX>();
            // Null std handles stop the child inheriting ours instead of the pseudo console's.
            si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;

            // CreateProcessW may write into the command line, so it gets a buffer of its own, ending in a null.
            if (!CreateProcess(null, (options.CommandLine + '\0').ToCharArray(), IntPtr.Zero, IntPtr.Zero, false,
                    EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environment, options.WorkingDirectory,
                    ref si, out var pi))
            {
                throw new Win32Exception();
            }
            return pi;
        }
        finally
        {
            DeleteProcThreadAttributeList(attrList);
            Marshal.FreeHGlobal(attrList);
            if (environment != IntPtr.Zero)
            {
                Marshal.FreeHGlobal(environment);
            }
        }
    }

    public void Resize(int columns, int rows)
    {
        var hpc = _pseudoConsole;
        if (hpc == IntPtr.Zero)
        {
            return;
        }

        var hr = ResizePseudoConsole(hpc, ToCoord(columns, rows));
        if (hr != 0)
        {
            Marshal.ThrowExceptionForHR(hr);
        }
    }

    public void Dispose()
    {
        _exitWait.Unregister(null);
        // Close our read end first: ClosePseudoConsole can block until pending output is drained.
        Output.Dispose();
        Input.Dispose();
        ClosePseudoConsoleOnce();
        _process.Dispose();
        _exited.TrySetCanceled();
    }

    private void OnProcessExited()
    {
        int code;
        try
        {
            code = GetExitCodeProcess(_process, out var exitCode) ? exitCode : -1;
        }
        catch (ObjectDisposedException)
        {
            return;
        }

        // Closing the pseudo console flushes remaining output and ends the Output stream.
        ClosePseudoConsoleOnce();
        _exited.TrySetResult(code);
    }

    private void ClosePseudoConsoleOnce()
    {
        var hpc = Interlocked.Exchange(ref _pseudoConsole, IntPtr.Zero);
        if (hpc != IntPtr.Zero)
        {
            ClosePseudoConsole(hpc);
        }
    }

    private static COORD ToCoord(int columns, int rows) =>
        new() { X = (short)Math.Clamp(columns, 1, short.MaxValue), Y = (short)Math.Clamp(rows, 1, short.MaxValue) };

    private sealed class ProcessWaitHandle : WaitHandle
    {
        public ProcessWaitHandle(SafeWaitHandle process) => SafeWaitHandle = process;
    }
}
