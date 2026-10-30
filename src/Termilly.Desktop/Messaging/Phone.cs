namespace Termilly.Desktop.Messaging;

// Termilly on a phone (Phone/, Features/Phone.cs, js/settings/phone.js): the server's state for Settings, pairing a
// phone, the paired phones and a test alert.

/// <summary>A paired phone as Settings lists it (times in ms): whether it takes alerts on its lock screen.</summary>
internal sealed record PhoneDevice(string Id = "", string Name = "", long Paired = 0, long LastSeen = 0, bool Alerts = false);

internal static partial class FromPage
{
    internal sealed record PhoneStatus : IPageMessage
    {
        public static string Type => "phone:status";
    }

    /// <summary>A pairing code for a new phone (good once, for a few minutes).</summary>
    internal sealed record PhonePair : IPageMessage
    {
        public static string Type => "phone:pair";
    }

    internal sealed record PhoneRemove(string? Device = null) : IPageMessage
    {
        public static string Type => "phone:remove";
    }

    /// <summary>
    /// An agent's news for the phones (js/notify.js decides, as for the PC's notifications): its state, the alert's
    /// title and text, and whether Termilly is the window in front (the host adds how long the PC has been idle).
    /// </summary>
    internal sealed record PhoneAlert(string Id = "", string? State = null, string? Title = null, string? Body = null, bool InFront = false) : IPageMessage
    {
        public static string Type => "phone:alert";
    }

    /// <summary>A test alert to every phone that takes alerts.</summary>
    internal sealed record PhoneTest : IPageMessage
    {
        public static string Type => "phone:test";
    }
}

internal static partial class ToPage
{
    /// <param name="SetupUrl">The plain-http page a new phone opens first, to get Termilly's certificate.</param>
    /// <param name="AppUrl">The phone app, over HTTPS.</param>
    internal sealed record PhoneStatus(bool Running, string? SetupUrl, string? AppUrl, string? Error, IReadOnlyList<PhoneDevice> Devices) : IHostMessage
    {
        public static string Type => "phone:status";
    }

    internal sealed record PhonePairing(string Code) : IHostMessage
    {
        public static string Type => "phone:pairing";
    }

    /// <summary>How the test alert went: how many phones it went to, and why it failed if it did.</summary>
    internal sealed record PhoneTested(int Sent, string? Error) : IHostMessage
    {
        public static string Type => "phone:tested";
    }
}
