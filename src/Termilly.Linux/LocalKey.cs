using System.Security.Cryptography;

namespace Termilly.Desktop.Security;

/// <summary>
/// What DPAPI does for the vault on Windows, on Linux: a random key in a file only this user can read
/// (~/.local/share/Termilly/local.key, mode 600), which locks the data key with AES-GCM. As with DPAPI's
/// current-user scope, any program running as this user could use it; the recovery code still unlocks the data if
/// the file is lost.
/// </summary>
internal static class LocalKey
{
    private static readonly Lazy<byte[]> Key = new(LoadOrCreate);

    private const int KeySize = 32;
    private const int NonceSize = 12;
    private const int TagSize = 16;
    /// <summary>Locked data is the nonce, the tag, then the ciphertext.</summary>
    private const int HeaderSize = NonceSize + TagSize;

    private static string KeyPath => Path.Combine(AppPaths.DataDirectory, "local.key");

    public static byte[] Protect(byte[] data, byte[] entropy)
    {
        var nonce = RandomNumberGenerator.GetBytes(NonceSize);
        var sealedData = new byte[data.Length];
        var tag = new byte[TagSize];
        using var aes = new AesGcm(Key.Value, TagSize);
        aes.Encrypt(nonce, data, sealedData, tag, entropy);
        return [.. nonce, .. tag, .. sealedData];
    }

    public static byte[] Unprotect(byte[] blob, byte[] entropy)
    {
        if (blob.Length < HeaderSize)
        {
            throw new CryptographicException("Too short to be locked data.");
        }
        var data = new byte[blob.Length - HeaderSize];
        using var aes = new AesGcm(Key.Value, TagSize);
        aes.Decrypt(blob.AsSpan(0, NonceSize), blob.AsSpan(HeaderSize), blob.AsSpan(NonceSize, TagSize), data, entropy);
        return data;
    }

    private static byte[] LoadOrCreate()
    {
        if (File.Exists(KeyPath))
        {
            var existing = File.ReadAllBytes(KeyPath);
            if (existing.Length == KeySize)
            {
                return existing;
            }
        }
        Directory.CreateDirectory(AppPaths.DataDirectory);
        var key = RandomNumberGenerator.GetBytes(KeySize);
        // Created readable by this user only, before the key goes in.
        using (var file = new FileStream(KeyPath, new FileStreamOptions
        {
            Mode = FileMode.Create,
            Access = FileAccess.Write,
            UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite,
        }))
        {
            file.Write(key);
        }
        return key;
    }
}
