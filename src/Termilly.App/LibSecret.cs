using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace Termilly.Desktop;

/// <summary>
/// The Linux keyring (the freedesktop Secret Service: GNOME Keyring, KWallet…) through libsecret: where Termilly
/// keeps an SSH connection's password on Linux, as Windows Credential Manager does on
/// Windows. Items are found by their target ("Termilly/ssh/&lt;id&gt;"), under the schema dev.termilly.Credential.
/// Compiled into the app and into the askpass helper (Termilly.Agent), which reads passwords when ssh asks. Calls
/// throw <see cref="InvalidOperationException"/> with the keyring's message when it says no.
/// </summary>
[SupportedOSPlatform("linux")]
internal static class LibSecret
{
    /// <summary>The one attribute Termilly's items have: the credential's target.</summary>
    private const string TargetAttribute = "target";
    /// <summary>GError's message, after its domain (4 bytes, padded) and code.</summary>
    private const int GErrorMessage = 8;

    /// <summary>SecretSchema's layout on 64-bit: offsets of its fields, and its size.</summary>
    private static class SchemaLayout
    {
        private const int Pointer = 8;
        private const int MaxAttributes = 32;
        /// <summary>A SecretSchemaAttribute: a name pointer and a type.</summary>
        private const int AttributeSize = 2 * Pointer;
        private const int Reserved = 8 * Pointer;

        public const int Name = 0;
        public const int Flags = Pointer;
        public const int FirstAttributeName = 2 * Pointer;
        public const int FirstAttributeType = FirstAttributeName + Pointer;
        public const int Size = FirstAttributeName + MaxAttributes * AttributeSize + Reserved;
    }

    private const string Secret = "libsecret-1.so.0";
    private const string GLib = "libglib-2.0.so.0";

    private static readonly Lazy<IntPtr> Schema = new(CreateSchema);

    /// <summary>Whether libsecret is installed and a keyring answers (looked at once).</summary>
    public static bool IsAvailable => Available.Value;

    private static readonly Lazy<bool> Available = new(() =>
    {
        if (!NativeLibrary.TryLoad(Secret, out _))
        {
            return false;
        }
        try
        {
            Lookup("Termilly/probe"); // no keyring service (a bare server, a container): this throws
            return true;
        }
        catch (Exception e) when (e is InvalidOperationException or DllNotFoundException or EntryPointNotFoundException)
        {
            return false;
        }
    });

    public static void Store(string target, string label, string secret) =>
        WithAttributes(target, attributes =>
        {
            var ok = secret_password_storev_sync(Schema.Value, attributes, null, label, secret, IntPtr.Zero, out var error);
            ThrowIf(error);
            return ok != 0 ? 0 : throw new InvalidOperationException("The keyring didn't save it.");
        });

    /// <summary>The secret kept for <paramref name="target"/>, or null when there's none.</summary>
    public static string? Lookup(string target)
    {
        string? found = null;
        WithAttributes(target, attributes =>
        {
            var secret = secret_password_lookupv_sync(Schema.Value, attributes, IntPtr.Zero, out var error);
            ThrowIf(error);
            if (secret != IntPtr.Zero)
            {
                found = Marshal.PtrToStringUTF8(secret);
                secret_password_free(secret); // clears it from memory, too
            }
            return 0;
        });
        return found;
    }

    public static void Clear(string target) =>
        WithAttributes(target, attributes =>
        {
            _ = secret_password_clearv_sync(Schema.Value, attributes, IntPtr.Zero, out var error); // false when nothing was saved
            ThrowIf(error);
            return 0;
        });

    /// <summary>Runs a call with the attributes { target } as a GHashTable of UTF-8 strings, freed afterwards.</summary>
    private static void WithAttributes(string target, Func<IntPtr, int> call)
    {
        var glib = NativeLibrary.Load(GLib);
        var table = g_hash_table_new(NativeLibrary.GetExport(glib, "g_str_hash"), NativeLibrary.GetExport(glib, "g_str_equal"));
        var key = Marshal.StringToCoTaskMemUTF8(TargetAttribute);
        var value = Marshal.StringToCoTaskMemUTF8(target);
        try
        {
            _ = g_hash_table_insert(table, key, value); // a new table: always a new key
            call(table);
        }
        finally
        {
            g_hash_table_unref(table);
            Marshal.FreeCoTaskMem(key);
            Marshal.FreeCoTaskMem(value);
        }
    }

    /// <summary>
    /// SecretSchema { name; flags; SecretSchemaAttribute attributes[32] { name; type }; reserved… }, built once and
    /// kept for the life of the process: "dev.termilly.Credential" with one string attribute, "target".
    /// </summary>
    private static IntPtr CreateSchema()
    {
        var schema = Marshal.AllocHGlobal(SchemaLayout.Size);
        for (var i = 0; i < SchemaLayout.Size; i++)
        {
            Marshal.WriteByte(schema, i, 0);
        }
        Marshal.WriteIntPtr(schema, SchemaLayout.Name, Marshal.StringToCoTaskMemUTF8("dev.termilly.Credential"));
        Marshal.WriteInt32(schema, SchemaLayout.Flags, 0); // SECRET_SCHEMA_NONE
        Marshal.WriteIntPtr(schema, SchemaLayout.FirstAttributeName, Marshal.StringToCoTaskMemUTF8(TargetAttribute));
        Marshal.WriteInt32(schema, SchemaLayout.FirstAttributeType, 0); // SECRET_SCHEMA_ATTRIBUTE_STRING; the zeroed next entry ends the list
        return schema;
    }

    /// <summary>A GError (domain, code, message) as an exception with its message, freed.</summary>
    private static void ThrowIf(IntPtr error)
    {
        if (error == IntPtr.Zero)
        {
            return;
        }
        var message = Marshal.PtrToStringUTF8(Marshal.ReadIntPtr(error, GErrorMessage)) ?? "The keyring refused.";
        g_error_free(error);
        throw new InvalidOperationException(message);
    }

    [DllImport(Secret)]
    private static extern int secret_password_storev_sync(IntPtr schema, IntPtr attributes,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string? collection, [MarshalAs(UnmanagedType.LPUTF8Str)] string label,
        [MarshalAs(UnmanagedType.LPUTF8Str)] string password, IntPtr cancellable, out IntPtr error);

    [DllImport(Secret)]
    private static extern IntPtr secret_password_lookupv_sync(IntPtr schema, IntPtr attributes, IntPtr cancellable, out IntPtr error);

    [DllImport(Secret)]
    private static extern int secret_password_clearv_sync(IntPtr schema, IntPtr attributes, IntPtr cancellable, out IntPtr error);

    [DllImport(Secret)]
    private static extern void secret_password_free(IntPtr password);

    [DllImport(GLib)]
    private static extern IntPtr g_hash_table_new(IntPtr hash, IntPtr equal);

    [DllImport(GLib)]
    private static extern int g_hash_table_insert(IntPtr table, IntPtr key, IntPtr value);

    [DllImport(GLib)]
    private static extern void g_hash_table_unref(IntPtr table);

    [DllImport(GLib)]
    private static extern void g_error_free(IntPtr error);
}
