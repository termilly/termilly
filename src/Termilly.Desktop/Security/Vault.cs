using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Termilly.Desktop.Security;

/// <summary>
/// The key that encrypts workspaces and history. It is stored twice in keys.json:
/// <list type="bullet">
/// <item>locked to the Windows account with DPAPI, so day-to-day use needs no password and survives normal
/// password changes;</item>
/// <item>locked with a recovery code the user keeps, so an admin password reset (which loses the DPAPI
/// keys) doesn't lose history. The code unlocks it once and the key is re-locked to the account.</item>
/// </list>
/// </summary>
internal sealed class Vault
{
    /// <summary>The vault's files in the data folder (and in an archive of an old one).</summary>
    private const string WorkspacesFile = "workspaces.tmw";
    private const string HistoryFolder = "history";
    private const string KeysFileName = "keys.json";
    private const int SaltSize = 16;
    /// <summary>A recovery code is shown in groups of this many characters.</summary>
    private const int CodeGroup = 4;

    private const int KeySize = 32;
    private const int Iterations = 210_000;
    private const string Alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I lookalikes
    private const int CodeLength = 24;
    private static readonly byte[] Entropy = "Termilly data key v1"u8.ToArray();
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };

    private readonly string _dir;

    private Vault(string dir) => _dir = dir;

    /// <summary>The data key, or null while locked.</summary>
    public byte[]? Key { get; private set; }

    public bool IsLocked => Key is null;

    /// <summary>True when the key was created in this run, so the user still has to save the recovery code.</summary>
    public bool IsNew { get; private set; }

    /// <summary>The user confirmed they saved the new recovery code.</summary>
    public void ConfirmCodeSaved() => IsNew = false;

    public string WorkspacesPath => Path.Combine(_dir, WorkspacesFile);
    public string HistoryDirectory => Path.Combine(_dir, HistoryFolder);
    private string KeysPath => Path.Combine(_dir, KeysFileName);

    /// <summary>A file of the vault's own in the data folder (sync settings, the last snapshot).</summary>
    public string PathOf(string fileName) => Path.Combine(_dir, fileName);

    /// <summary>An encrypted JSON file, opened; null when it's missing, the vault is locked, or it's damaged or from another key.</summary>
    public JsonDocument? ReadJson(string path)
    {
        try
        {
            return File.Exists(path) && Key is { } key ? JsonDocument.Parse(Sealed.OpenText(key, File.ReadAllBytes(path))) : null;
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException or CryptographicException)
        {
            return null; // starts without it rather than failing
        }
    }

    /// <summary>Writes <paramref name="text"/> encrypted. Never while locked: that would replace data the recovery code can still bring back.</summary>
    public void WriteSealed(string path, string text)
    {
        if (Key is { } key)
        {
            AppPaths.WriteAtomically(path, Sealed.Seal(key, text));
        }
    }

    /// <summary>Folders holding data that was set aside by "Start fresh" while it couldn't be unlocked.</summary>
    public IReadOnlyList<string> Archives =>
        Directory.Exists(_dir) ? Directory.GetDirectories(_dir, "locked-*").Order().ToList() : [];

    /// <summary>
    /// Opens the vault in <paramref name="dir"/>: unlocks it with the Windows account, or creates it (and
    /// encrypts any plain files left by older versions). Stays locked if the account can't unlock it.
    /// </summary>
    public static Vault Open(string dir)
    {
        var vault = new Vault(dir);
        if (File.Exists(vault.KeysPath))
        {
            var keys = vault.ReadKeys();
            vault.Key = keys is null ? null : Unprotect(keys.DpapiKey);
        }
        else
        {
            vault.Create();
        }

        if (!vault.IsLocked)
        {
            vault.EncryptPlainFiles();
        }
        return vault;
    }

    /// <summary>The recovery code, readable only while unlocked by the Windows account.</summary>
    public string? RecoveryCode()
    {
        var keys = ReadKeys();
        var code = keys is null ? null : Unprotect(keys.DpapiCode);
        return code is null ? null : Format(Encoding.UTF8.GetString(code));
    }

    /// <summary>Unlocks with the recovery code and re-locks the key to the current Windows account.</summary>
    public bool TryRecover(string code)
    {
        var keys = ReadKeys();
        var key = keys is null ? null : KeyFromCode(keys, code);
        if (keys is null || key is null)
        {
            return false;
        }

        Key = key;
        WriteKeys(keys with
        {
            DpapiKey = Protect(key),
            DpapiCode = Protect(Encoding.UTF8.GetBytes(Normalize(code))),
        });
        EncryptPlainFiles();
        return true;
    }

    /// <summary>Replaces the recovery code (the old one stops working) and returns the new one.</summary>
    public string RegenerateRecoveryCode()
    {
        var key = Key ?? throw new InvalidOperationException("The vault is locked.");
        var code = NewCode();
        WriteKeys(KeysFor(key, code));
        return Format(code);
    }

    /// <summary>
    /// Sets the data that can't be unlocked aside in a locked-&lt;time&gt; folder (nothing is deleted) and
    /// starts a new, empty vault.
    /// </summary>
    public void StartFresh()
    {
        var archive = Path.Combine(_dir, $"locked-{DateTime.Now:yyyyMMdd-HHmmss}");
        Directory.CreateDirectory(Path.Combine(archive, HistoryFolder));
        File.Move(KeysPath, Path.Combine(archive, KeysFileName));
        if (File.Exists(WorkspacesPath))
        {
            File.Move(WorkspacesPath, Path.Combine(archive, WorkspacesFile));
        }
        if (Directory.Exists(HistoryDirectory))
        {
            foreach (var file in Directory.EnumerateFiles(HistoryDirectory, "*.tmh"))
            {
                File.Move(file, Path.Combine(archive, HistoryFolder, Path.GetFileName(file)));
            }
        }
        Create();
    }

    /// <summary>
    /// Brings closed-terminal history back from set-aside folders that <paramref name="code"/> unlocks,
    /// re-encrypted with the current key. Returns how many entries came back, or -1 if the code fits none.
    /// </summary>
    public int RestoreArchives(string code)
    {
        var key = Key ?? throw new InvalidOperationException("The vault is locked.");
        var restored = -1;
        foreach (var archive in Archives)
        {
            var keys = ReadKeys(Path.Combine(archive, KeysFileName));
            var oldKey = keys is null ? null : KeyFromCode(keys, code);
            if (oldKey is null)
            {
                continue;
            }

            restored = Math.Max(restored, 0);
            Directory.CreateDirectory(HistoryDirectory);
            var archivedHistory = Path.Combine(archive, HistoryFolder);
            if (Directory.Exists(archivedHistory))
            {
                foreach (var file in Directory.EnumerateFiles(archivedHistory, "*.tmh"))
                {
                    var target = Path.Combine(HistoryDirectory, Path.GetFileName(file));
                    if (!File.Exists(target))
                    {
                        AppPaths.WriteAtomically(target, Sealed.Seal(key, Sealed.Open(oldKey, File.ReadAllBytes(file))));
                        restored++;
                    }
                }
            }
            Directory.Delete(archive, recursive: true);
        }
        return restored;
    }

    // ---- Internals ----

    private void Create()
    {
        var key = RandomNumberGenerator.GetBytes(KeySize);
        WriteKeys(KeysFor(key, NewCode()));
        Key = key;
        IsNew = true;
    }

    /// <summary>Older versions stored plain JSON; encrypt it and remove the plain copies.</summary>
    private void EncryptPlainFiles()
    {
        var plainWorkspaces = Path.Combine(_dir, "workspaces.json");
        if (File.Exists(plainWorkspaces))
        {
            AppPaths.WriteAtomically(WorkspacesPath, Sealed.Seal(Key!, File.ReadAllBytes(plainWorkspaces)));
            File.Delete(plainWorkspaces);
        }
        if (Directory.Exists(HistoryDirectory))
        {
            foreach (var file in Directory.EnumerateFiles(HistoryDirectory, "*.json"))
            {
                AppPaths.WriteAtomically(Path.ChangeExtension(file, ".tmh"), Sealed.Seal(Key!, File.ReadAllBytes(file)));
                File.Delete(file);
            }
        }
    }

    private static KeysFile KeysFor(byte[] key, string code)
    {
        var salt = RandomNumberGenerator.GetBytes(SaltSize);
        return new KeysFile(
            Version: 1,
            DpapiKey: Protect(key),
            DpapiCode: Protect(Encoding.UTF8.GetBytes(code)),
            Salt: Convert.ToBase64String(salt),
            Iterations: Iterations,
            RecoveryKey: Convert.ToBase64String(Sealed.Seal(CodeKey(code, salt, Iterations), key)));
    }

    private static byte[]? KeyFromCode(KeysFile keys, string code)
    {
        try
        {
            var codeKey = CodeKey(Normalize(code), Convert.FromBase64String(keys.Salt), keys.Iterations);
            return Sealed.Open(codeKey, Convert.FromBase64String(keys.RecoveryKey));
        }
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null;
        }
    }

    private static byte[] CodeKey(string code, byte[] salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(code), salt, iterations, HashAlgorithmName.SHA256, KeySize);

    private static string NewCode() =>
        string.Concat(Enumerable.Range(0, CodeLength).Select(_ => Alphabet[RandomNumberGenerator.GetInt32(Alphabet.Length)]));

    /// <summary>Upper-case, without the dashes and spaces people type or paste.</summary>
    private static string Normalize(string code) =>
        string.Concat(code.ToUpperInvariant().Where(char.IsLetterOrDigit));

    private static string Format(string code) => string.Join('-', code.Chunk(CodeGroup).Select(c => new string(c)));

#if LINUX
    // Linux has no DPAPI: the data key is locked with a key kept in a file only this user can read (LocalKey).
    private static string Protect(byte[] data) => Convert.ToBase64String(LocalKey.Protect(data, Entropy));

    private static byte[]? Unprotect(string data)
    {
        try
        {
            return LocalKey.Unprotect(Convert.FromBase64String(data), Entropy);
        }
#else
    private static string Protect(byte[] data) =>
        Convert.ToBase64String(ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser));

    private static byte[]? Unprotect(string data)
    {
        try
        {
            return ProtectedData.Unprotect(Convert.FromBase64String(data), Entropy, DataProtectionScope.CurrentUser);
        }
#endif
        catch (Exception e) when (e is CryptographicException or FormatException)
        {
            return null; // e.g. after an admin password reset, or keys.json copied from another account
        }
    }

    private KeysFile? ReadKeys() => ReadKeys(KeysPath);

    private static KeysFile? ReadKeys(string path)
    {
        try
        {
            return JsonSerializer.Deserialize<KeysFile>(File.ReadAllText(path), Json);
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    private void WriteKeys(KeysFile keys) => AppPaths.WriteAtomically(KeysPath, JsonSerializer.Serialize(keys, Json));

    private sealed record KeysFile(int Version, string DpapiKey, string DpapiCode, string Salt, int Iterations, string RecoveryKey);
}
