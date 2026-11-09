using System.Security.Cryptography;
using System.Text;

namespace Termilly.Desktop.Security;

/// <summary>
/// AES-256-GCM for the files Termilly keeps on disk. Layout: "TMLY1", 12-byte nonce, 16-byte tag, ciphertext.
/// Any change to the bytes (or the wrong key) fails <see cref="Open"/> instead of returning garbage.
/// </summary>
internal static class Sealed
{
    private static readonly byte[] Magic = "TMLY1"u8.ToArray();
    private const int NonceSize = 12;
    private const int TagSize = 16;
    private static int HeaderSize => Magic.Length + NonceSize + TagSize;

    public static byte[] Seal(byte[] key, byte[] plaintext)
    {
        var output = new byte[HeaderSize + plaintext.Length];
        Magic.CopyTo(output, 0);
        var nonce = output.AsSpan(Magic.Length, NonceSize);
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, TagSize);
        aes.Encrypt(nonce, plaintext, output.AsSpan(HeaderSize), output.AsSpan(Magic.Length + NonceSize, TagSize));
        return output;
    }

    public static byte[] Seal(byte[] key, string text) => Seal(key, Encoding.UTF8.GetBytes(text));

    /// <summary>Decrypts a sealed blob. Throws <see cref="CryptographicException"/> when it is damaged or the key is wrong.</summary>
    public static byte[] Open(byte[] key, byte[] blob)
    {
        if (blob.Length < HeaderSize || !blob.AsSpan(0, Magic.Length).SequenceEqual(Magic))
        {
            throw new CryptographicException("Not a Termilly encrypted file.");
        }

        var plaintext = new byte[blob.Length - HeaderSize];
        using var aes = new AesGcm(key, TagSize);
        aes.Decrypt(
            blob.AsSpan(Magic.Length, NonceSize),
            blob.AsSpan(HeaderSize),
            blob.AsSpan(Magic.Length + NonceSize, TagSize),
            plaintext);
        return plaintext;
    }

    public static string OpenText(byte[] key, byte[] blob) => Encoding.UTF8.GetString(Open(key, blob));
}
