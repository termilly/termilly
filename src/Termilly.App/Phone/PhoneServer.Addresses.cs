using System.Net;
using System.Net.Sockets;

namespace Termilly.Desktop.Phone;

/// <summary>Which of this computer's addresses the phone server listens on, and which addresses are private.</summary>
internal sealed partial class PhoneServer
{
    /// <summary>The private IPv4 ranges (10/8, 172.16/12, 192.168/16) and the shared range VPNs like Tailscale use (100.64/10).</summary>
    private static class PrivateRanges
    {
        public const byte TenNet = 10;
        public const byte ClassB = 172;
        public const byte ClassBFrom = 16;
        public const byte ClassBTo = 31;
        public const byte ClassC = 192;
        public const byte ClassCSecond = 168;
        public const byte Shared = 100;
        public const byte SharedFrom = 64;
        public const byte SharedTo = 127;
        /// <summary>169.254.x: an address a network adapter gave itself, reaching nothing.</summary>
        public const byte LinkLocal = 169;
        public const byte LinkLocalSecond = 254;
    }

    /// <summary>
    /// The address to listen on: the first private one, else the first of any other. A cloud machine's network can use
    /// any subnet, or have a public address only.
    /// </summary>
    internal static IPAddress? Pick(IEnumerable<IPAddress> addresses)
    {
        var usable = addresses.Where(IsUsable).ToList();
        return usable.Find(IsPrivate) ?? usable.FirstOrDefault();
    }

    private static bool IsUsable(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork || IPAddress.IsLoopback(address))
        {
            return false;
        }
        var b = address.GetAddressBytes();
        return b[0] != PrivateRanges.LinkLocal || b[1] != PrivateRanges.LinkLocalSecond;
    }

    public static bool IsPrivate(IPAddress address)
    {
        if (address.AddressFamily != AddressFamily.InterNetwork)
        {
            return false;
        }
        var b = address.GetAddressBytes();
        return b[0] == PrivateRanges.TenNet || (b[0] == PrivateRanges.ClassB && b[1] is >= PrivateRanges.ClassBFrom and <= PrivateRanges.ClassBTo) ||
               (b[0] == PrivateRanges.ClassC && b[1] == PrivateRanges.ClassCSecond) ||
               (b[0] == PrivateRanges.Shared && b[1] is >= PrivateRanges.SharedFrom and <= PrivateRanges.SharedTo);
    }
}
