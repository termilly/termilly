using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

namespace Termilly.Shared;

/// <summary>
/// Windows Credential Manager (generic credentials, for the current user): where an SSH connection's password can
/// be kept, under "Termilly/ssh/&lt;id&gt;", and the AI assistant's API key ("Termilly/ai/anthropic"). ssh passwords are
/// read by the askpass helper when ssh asks (Termilly.Agent/Askpass.cs); the app reads them only to keep them out of
/// what the AI assistant sends (Assistant.cs). Shared, so the app and the helper read the same way.
/// </summary>
internal static class WindowsCredentials
{
    private const int CRED_TYPE_GENERIC = 1;
    private const int CRED_PERSIST_LOCAL_MACHINE = 2;

    public static void Save(string target, string user, string password, string comment = "Saved by Termilly for an SSH connection")
    {
        var secret = Encoding.Unicode.GetBytes(password);
        var blob = Marshal.AllocHGlobal(secret.Length);
        try
        {
            Marshal.Copy(secret, 0, blob, secret.Length);
            var credential = new CREDENTIAL
            {
                Type = CRED_TYPE_GENERIC,
                TargetName = target,
                UserName = user,
                CredentialBlob = blob,
                CredentialBlobSize = secret.Length,
                Persist = CRED_PERSIST_LOCAL_MACHINE,
                Comment = comment,
            };
            if (!CredWrite(ref credential, 0))
            {
                throw new Win32Exception();
            }
        }
        finally
        {
            Array.Clear(secret);
            Marshal.ZeroFreeGlobalAllocUnicode(blob);
        }
    }

    public static bool Exists(string target)
    {
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out var handle))
        {
            return false;
        }
        CredFree(handle);
        return true;
    }

    public static void Delete(string target) => CredDelete(target, CRED_TYPE_GENERIC, 0);

    /// <summary>The saved secret, or null when there's none.</summary>
    public static string? Read(string target)
    {
        if (!CredRead(target, CRED_TYPE_GENERIC, 0, out var handle))
        {
            return null;
        }
        try
        {
            var credential = Marshal.PtrToStructure<CREDENTIAL>(handle);
            return credential.CredentialBlobSize > 0 ? Marshal.PtrToStringUni(credential.CredentialBlob, credential.CredentialBlobSize / 2) : null;
        }
        finally
        {
            CredFree(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct CREDENTIAL
    {
        public int Flags;
        public int Type;
        public string TargetName;
        public string? Comment;
        public long LastWritten;
        public int CredentialBlobSize;
        public IntPtr CredentialBlob;
        public int Persist;
        public int AttributeCount;
        public IntPtr Attributes;
        public string? TargetAlias;
        public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref CREDENTIAL credential, int flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, int type, int flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, int type, int flags);

    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr buffer);
}
