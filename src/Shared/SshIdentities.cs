namespace Termilly.Shared;

/// <summary>
/// How an SSH connection signs in (Settings › SSH). Termilly never stores a secret: a password is a reference that
/// the askpass helper (Termilly.Agent/Askpass.cs) reads when ssh asks.
/// </summary>
internal static class SshIdentities
{
    /// <summary>ssh-agent, or ssh's defaults.</summary>
    public const string Agent = "agent";
    /// <summary>A key file.</summary>
    public const string Key = "key";
    /// <summary>A FIDO2 security key's key file.</summary>
    public const string SecurityKey = "sk";
    /// <summary>A password kept in the system's credential store (Windows Credential Manager, the Linux keyring).</summary>
    public const string SavedPassword = "wincred";
    /// <summary>A 1Password reference (op://vault/item/field) read with the 1Password CLI.</summary>
    public const string OnePassword = "op";

    public static readonly IReadOnlyList<string> All = [Agent, Key, SecurityKey, SavedPassword, OnePassword];

    public static bool UsesKeyFile(string? identity) => identity is Key or SecurityKey;

    /// <summary>Signs in with a password the askpass helper reads from a reference.</summary>
    public static bool UsesPassword(string? identity) => identity is SavedPassword or OnePassword;
}

/// <summary>What the askpass helper is given to read a password from: "wincred:&lt;target&gt;" or "op:&lt;op://...&gt;".</summary>
internal static class CredentialReference
{
    private const char Separator = ':';

    public static string For(string identity, string value) => identity + Separator + value;

    /// <summary>The value of a reference of this kind; null for a reference of another kind.</summary>
    public static string? Read(string reference, string identity) =>
        reference.StartsWith(identity + Separator, StringComparison.Ordinal) ? reference[(identity.Length + 1)..] : null;
}
