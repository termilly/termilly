using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// The macOS login keychain, through Security.framework's generic passwords: where Termilly keeps an SSH connection's
/// password on macOS, as the keyring does on Linux. An item's service is its target ("Termilly/ssh/&lt;id&gt;"), so
/// it's found by that alone. Compiled into the app and into the askpass helper (Termilly.Agent); macOS asks the user
/// before the helper first reads an item the app saved. Calls throw <see cref="InvalidOperationException"/> when the
/// keychain says no.
/// </summary>
[SupportedOSPlatform("macos")]
internal static class MacKeychain
{
    private const string Security = "/System/Library/Frameworks/Security.framework/Security";
    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    private const int Ok = 0;
    private const int ItemNotFound = -25300;

    /// <summary>Saves a password, replacing the one saved for the target before.</summary>
    public static void Store(string target, string account, string secret)
    {
        var service = Encoding.UTF8.GetBytes(target);
        var data = Encoding.UTF8.GetBytes(secret);
        try
        {
            var item = Find(service, out _);
            if (item != IntPtr.Zero)
            {
                try
                {
                    Check(SecKeychainItemModifyAttributesAndData(item, IntPtr.Zero, (uint)data.Length, data));
                }
                finally
                {
                    CFRelease(item);
                }
                return;
            }
            var user = Encoding.UTF8.GetBytes(account);
            Check(SecKeychainAddGenericPassword(IntPtr.Zero, (uint)service.Length, service, (uint)user.Length, user, (uint)data.Length, data, out var added));
            CFRelease(added);
        }
        finally
        {
            Array.Clear(data);
        }
    }

    /// <summary>The password saved for a target, or null when there's none.</summary>
    public static string? Lookup(string target)
    {
        var item = Find(Encoding.UTF8.GetBytes(target), out var secret);
        if (item != IntPtr.Zero)
        {
            CFRelease(item);
        }
        return secret;
    }

    /// <summary>Removes a target's password; nothing when there's none.</summary>
    public static void Clear(string target)
    {
        var item = Find(Encoding.UTF8.GetBytes(target), out _);
        if (item == IntPtr.Zero)
        {
            return;
        }
        try
        {
            Check(SecKeychainItemDelete(item));
        }
        finally
        {
            CFRelease(item);
        }
    }

    /// <summary>The item saved for a service (released by the caller), and its password; zero and null when there's none.</summary>
    private static IntPtr Find(byte[] service, out string? secret)
    {
        secret = null;
        var status = SecKeychainFindGenericPassword(IntPtr.Zero, (uint)service.Length, service, 0, null, out var length, out var data, out var item);
        if (status == ItemNotFound)
        {
            return IntPtr.Zero;
        }
        Check(status);
        try
        {
            secret = Marshal.PtrToStringUTF8(data, (int)length);
        }
        finally
        {
            _ = SecKeychainItemFreeContent(IntPtr.Zero, data); // only fails for a pointer it didn't hand out
        }
        return item;
    }

    /// <summary>The status macOS gives when the keychain is locked and nobody can be asked to unlock it (an SSH session).</summary>
    public const int InteractionNotAllowed = -25308;

    /// <summary>Throws for a status that isn't success; the exception's HResult is the status.</summary>
    private static void Check(int status)
    {
        if (status != Ok)
        {
            throw new InvalidOperationException($"The keychain said no (error {status}).") { HResult = status };
        }
    }

    [DllImport(Security)]
    private static extern int SecKeychainFindGenericPassword(IntPtr keychains, uint serviceLength, byte[] service, uint accountLength, byte[]? account,
        out uint passwordLength, out IntPtr password, out IntPtr item);

    [DllImport(Security)]
    private static extern int SecKeychainAddGenericPassword(IntPtr keychain, uint serviceLength, byte[] service, uint accountLength, byte[] account,
        uint passwordLength, byte[] password, out IntPtr item);

    [DllImport(Security)]
    private static extern int SecKeychainItemModifyAttributesAndData(IntPtr item, IntPtr attributes, uint length, byte[] data);

    [DllImport(Security)]
    private static extern int SecKeychainItemDelete(IntPtr item);

    [DllImport(Security)]
    private static extern int SecKeychainItemFreeContent(IntPtr attributes, IntPtr data);

    [DllImport(CoreFoundation)]
    private static extern void CFRelease(IntPtr value);
}
