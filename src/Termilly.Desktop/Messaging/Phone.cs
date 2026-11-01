using System.Text.Json;

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

    /// <summary>A terminal's news is old (its agent answered or moved on): an alert held until the user is away doesn't go.</summary>
    internal sealed record PhoneWithdraw(string Id = "") : IPageMessage
    {
        public static string Type => "phone:withdraw";
    }

    /// <summary>
    /// What the phones show (js/phone.js builds it whenever a terminal or agent changes): the workspaces and their
    /// terminals, with what each agent is doing or waiting for.
    /// </summary>
    internal sealed record PhoneState(JsonElement State = default) : IPageMessage
    {
        public static string Type => "phone:state";
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

    /// <summary>
    /// A phone shows this terminal: it takes the phone's size until no phone shows it (Cols and Rows null), so it fills
    /// the phone and its output fits it. Name and Address say which phone (its paired name, its network address);
    /// Computer, that it's another Termilly computer rather than a phone (Name is then the computer's own).
    /// </summary>
    internal sealed record PhoneSize(string Id, int? Cols, int? Rows, string? Name, string? Address, bool Computer = false) : IHostMessage
    {
        public static string Type => "phone:size";
    }

    /// <summary>A phone pastes a Smart Clip clip into a terminal: the page pastes its text, as its own Paste would (js/smartclip.js).</summary>
    internal sealed record PhoneClip(string Pane, string Id) : IHostMessage
    {
        public static string Type => "phone:clip";
    }

    /// <summary>A key a phone typed into a terminal: one that answers its agent counts as typed on the PC (js/phone.js).</summary>
    internal sealed record PhoneTyped(string Id, string Data) : IHostMessage
    {
        public static string Type => "phone:typed";
    }

    /// <summary>
    /// A phone has this terminal on its screen (opened there, or its news came while it was): the news there is seen,
    /// as when the terminal is focused on the PC (js/phone.js).
    /// </summary>
    internal sealed record PhoneSeen(string Id) : IHostMessage
    {
        public static string Type => "phone:seen";
    }
}
