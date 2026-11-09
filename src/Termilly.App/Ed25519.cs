using System.Numerics;
using System.Security.Cryptography;

namespace Termilly.Desktop;

/// <summary>
/// Ed25519 signature verification (RFC 8032, section 5.1.7), for the signed update manifest (UpdateCheck.cs).
/// .NET has no Ed25519, and only verifying is needed: this follows the RFC's reference code on BigInteger.
/// It's slow by crypto standards (milliseconds), which is fine for one manifest every few hours.
/// </summary>
internal static class Ed25519
{
    private const int KeySize = 32;
    private const int SignatureSize = 2 * KeySize;
    /// <summary>The bit of an encoded point that holds x's sign; the ones below it are y.</summary>
    private const int SignBit = 255;
    /// <summary>The base point's y, 4/5 (RFC 8032, section 5.1).</summary>
    private const int BaseYNumerator = 4;
    private const int BaseYDenominator = 5;
    /// <summary>x = x2^((p+3)/8): the square root candidate for p ≡ 5 (mod 8).</summary>
    private const int RootOffset = 3;
    private const int RootDivisor = 8;

    private static readonly BigInteger P = BigInteger.Pow(2, SignBit) - 19;
    private static readonly BigInteger L = BigInteger.Pow(2, 252) + BigInteger.Parse("27742317777372353535851937790883648493", System.Globalization.CultureInfo.InvariantCulture);
    private static readonly BigInteger D = Mod(-121665 * Inverse(121666));
    private static readonly BigInteger SqrtMinusOne = BigInteger.ModPow(2, (P - 1) / 4, P);
    private static readonly Point Base = BasePoint();

    private readonly record struct Point(BigInteger X, BigInteger Y, BigInteger Z, BigInteger T);

    /// <summary>Whether <paramref name="signature"/> (64 bytes) is <paramref name="publicKey"/>'s (32 bytes) signature of the message.</summary>
    public static bool Verify(ReadOnlySpan<byte> publicKey, ReadOnlySpan<byte> message, ReadOnlySpan<byte> signature)
    {
        if (publicKey.Length != KeySize || signature.Length != SignatureSize)
        {
            return false;
        }
        if (Decompress(publicKey) is not { } a || Decompress(signature[..KeySize]) is not { } r)
        {
            return false;
        }
        var s = Little(signature[KeySize..]);
        if (s >= L)
        {
            return false;
        }
        var hashed = new byte[SignatureSize + message.Length];
        signature[..KeySize].CopyTo(hashed);
        publicKey.CopyTo(hashed.AsSpan(KeySize));
        message.CopyTo(hashed.AsSpan(SignatureSize));
        var h = Little(SHA512.HashData(hashed)) % L;
        return SameAs(Multiply(s, Base), Add(r, Multiply(h, a)));
    }

    private static BigInteger Mod(BigInteger x) => (x % P + P) % P;

    private static BigInteger Inverse(BigInteger x) => BigInteger.ModPow(x, P - 2, P);

    private static BigInteger Little(ReadOnlySpan<byte> bytes) => new(bytes, isUnsigned: true, isBigEndian: false);

    private static Point Add(Point p, Point q)
    {
        var a = Mod((p.Y - p.X) * (q.Y - q.X));
        var b = Mod((p.Y + p.X) * (q.Y + q.X));
        var c = Mod(p.T * 2 * D * q.T);
        var d = Mod(p.Z * 2 * q.Z);
        var (e, f, g, h) = (b - a, d - c, d + c, b + a);
        return new Point(Mod(e * f), Mod(g * h), Mod(f * g), Mod(e * h));
    }

    private static Point Multiply(BigInteger s, Point p)
    {
        var q = new Point(0, 1, 1, 0);
        while (s > 0)
        {
            if (!s.IsEven)
            {
                q = Add(q, p);
            }
            p = Add(p, p);
            s >>= 1;
        }
        return q;
    }

    private static bool SameAs(Point p, Point q) =>
        Mod(p.X * q.Z - q.X * p.Z).IsZero && Mod(p.Y * q.Z - q.Y * p.Z).IsZero;

    private static BigInteger? RecoverX(BigInteger y, bool sign)
    {
        if (y >= P)
        {
            return null;
        }
        var x2 = Mod((y * y - 1) * Inverse(Mod(D * y * y + 1)));
        if (x2.IsZero)
        {
            return sign ? null : BigInteger.Zero;
        }
        var x = BigInteger.ModPow(x2, (P + RootOffset) / RootDivisor, P);
        if (!Mod(x * x - x2).IsZero)
        {
            x = Mod(x * SqrtMinusOne);
        }
        if (!Mod(x * x - x2).IsZero)
        {
            return null;
        }
        return x.IsEven == sign ? P - x : x;
    }

    private static Point? Decompress(ReadOnlySpan<byte> bytes)
    {
        var y = Little(bytes);
        var sign = !(y >> SignBit).IsZero;
        y &= (BigInteger.One << SignBit) - 1;
        if (RecoverX(y, sign) is not { } x)
        {
            return null;
        }
        return new Point(x, y, 1, Mod(x * y));
    }

    private static Point BasePoint()
    {
        var y = Mod(BaseYNumerator * Inverse(BaseYDenominator));
        var x = RecoverX(y, false)!.Value;
        return new Point(x, y, 1, Mod(x * y));
    }
}
