using System;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using Microsoft.Win32.SafeHandles;
#if !NETFRAMEWORK
using System.Runtime.Versioning;
#endif

namespace Termilly.Shared;

/// <summary>Paint acknowledgements between the updater and the app, in this Windows session only.</summary>
#if !NETFRAMEWORK
[SupportedOSPlatform(OsPlatforms.Windows)]
#endif
internal static class UpdateSignals
{
    public const string Shown = "shown";
    public const string Started = "started";
    /// <summary>A scope's length: a SHA-256 hash in hex.</summary>
    private const int ScopeLength = 64;
    private const uint EventAccess = 0x00100002; // SYNCHRONIZE | EVENT_MODIFY_STATE
    private const int SddlRevision = 1;

    public static string Scope(string installDir)
    {
        using var identity = WindowsIdentity.GetCurrent();
        return ScopeFor(installDir, identity.User!.Value);
    }

    internal static string ScopeFor(string installDir, string user)
    {
        var path = Path.GetFullPath(installDir).TrimEnd('\\', '/').ToUpperInvariant();
#if NETFRAMEWORK
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(Encoding.UTF8.GetBytes(user + "\n" + path));
#else
        var hash = SHA256.HashData(Encoding.UTF8.GetBytes(user + "\n" + path));
#endif
        var text = new StringBuilder(hash.Length * 2);
        foreach (var b in hash)
        {
            text.Append(b.ToString("x2", CultureInfo.InvariantCulture));
        }
        return text.ToString();
    }

    public static bool IsScope(string? scope)
    {
        if (scope is null || scope.Length != ScopeLength)
        {
            return false;
        }
        foreach (var c in scope)
        {
            if (c is not (>= '0' and <= '9') and not (>= 'a' and <= 'f'))
            {
                return false;
            }
        }
        return true;
    }

    private static string Name(string scope, string stage)
    {
        if (!IsScope(scope))
        {
            throw new ArgumentException("Invalid update event scope.", nameof(scope));
        }
        if (stage != Shown && stage != Started)
        {
            throw new ArgumentException("Invalid update event stage.", nameof(stage));
        }
        return @"Local\Termilly.Update." + scope + "." + stage;
    }

    /// <summary>The initiating user, administrators and SYSTEM can use the events across UAC elevation.
    /// A medium integrity label also permits the unelevated app to signal an event created by elevated setup.</summary>
    public static EventWaitHandle Create(string scope, string stage)
    {
        using var identity = WindowsIdentity.GetCurrent();
        var sddl = $"D:P(A;;GA;;;{identity.User!.Value})(A;;GA;;;BA)(A;;GA;;;SY)S:(ML;;NW;;;ME)";
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor(sddl, SddlRevision, out var descriptor, out _))
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        try
        {
            var security = new SecurityAttributes { Length = Marshal.SizeOf<SecurityAttributes>(), Descriptor = descriptor };
            var handle = CreateEvent(ref security, true, false, Name(scope, stage));
            if (handle.IsInvalid)
            {
                var error = Marshal.GetLastWin32Error();
                handle.Dispose();
                throw new Win32Exception(error);
            }
            return Wrap(handle);
        }
        finally { _ = LocalFree(descriptor); }
    }

    public static bool SignalStarted(string installDir)
    {
        using var handle = OpenEvent(EventAccess, false, Name(Scope(installDir), Started));
        if (handle.IsInvalid)
        {
            return false; // normal start, or setup has already stopped waiting
        }
        using var signal = Wrap(handle);
        return signal.Set();
    }

    private static EventWaitHandle Wrap(SafeWaitHandle handle)
    {
        var signal = new EventWaitHandle(false, EventResetMode.ManualReset);
        signal.SafeWaitHandle.Dispose();
        signal.SafeWaitHandle = handle;
        return signal;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityAttributes
    {
        public int Length;
        public IntPtr Descriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool Inherit;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string text, int revision, out IntPtr descriptor, out uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle CreateEvent(ref SecurityAttributes security, [MarshalAs(UnmanagedType.Bool)] bool manualReset, [MarshalAs(UnmanagedType.Bool)] bool initialState, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeWaitHandle OpenEvent(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
}
