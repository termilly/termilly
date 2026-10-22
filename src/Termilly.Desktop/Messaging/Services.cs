namespace Termilly.Desktop.Messaging;

// Recordings and session logs, phone check-in, history sync between PCs, and the vault's
// recovery code.

internal static partial class FromPage
{
    /// <param name="Seed">The screen as it is now, so the recording starts with it.</param>
    internal sealed record RecStart(string Id = "", int Cols = RecStart.DefaultCols, int Rows = RecStart.DefaultRows, string? Title = null,
        string? Seed = null) : IPageMessage
    {
        public const int DefaultCols = 80;
        public const int DefaultRows = 24;

        public static string Type => "rec:start";
    }

    internal sealed record RecStop(string Id = "") : IPageMessage
    {
        public static string Type => "rec:stop";
    }

    /// <summary>A chapter mark in the recording (a command started).</summary>
    internal sealed record RecMark(string Id = "", string? Label = null) : IPageMessage
    {
        public static string Type => "rec:mark";
    }

    internal sealed record RecList : IPageMessage
    {
        public static string Type => "rec:list";
    }

    internal sealed record RecLoad(string? Path = null) : IPageMessage
    {
        public static string Type => "rec:load";
    }

    /// <summary>Shows a recording in the file manager, or the recordings folder.</summary>
    internal sealed record RecReveal(string? Path = null) : IPageMessage
    {
        public static string Type => "rec:reveal";
    }

    internal sealed record LogStart(string Id = "", string? Workspace = null, string? Name = null) : IPageMessage
    {
        public static string Type => "log:start";
    }

    /// <summary>Lines for a plain-text log: the page's own, without the terminal's escape sequences.</summary>
    internal sealed record LogLines(string Id = "", IReadOnlyList<string>? Lines = null) : IPageMessage
    {
        public static string Type => "log:lines";
    }

    internal sealed record LogStop(string Id = "") : IPageMessage
    {
        public static string Type => "log:stop";
    }

    internal sealed record LogReveal(string Id = "") : IPageMessage
    {
        public static string Type => "log:reveal";
    }

    internal sealed record CheckinStatus : IPageMessage
    {
        public static string Type => "checkin:status";
    }

    internal sealed record CheckinPair : IPageMessage
    {
        public static string Type => "checkin:pair";
    }

    internal sealed record CheckinRemove(string? Device = null) : IPageMessage
    {
        public static string Type => "checkin:remove";
    }

    internal sealed record SyncStatus : IPageMessage
    {
        public static string Type => "sync:status";
    }

    /// <summary>Turns sync on with a shared folder: this PC makes the code the others join with.</summary>
    internal sealed record SyncOn(string? Folder = null) : IPageMessage
    {
        public static string Type => "sync:on";
    }

    internal sealed record SyncJoin(string? Folder = null, string? Code = null) : IPageMessage
    {
        public static string Type => "sync:join";
    }

    internal sealed record SyncNow : IPageMessage
    {
        public static string Type => "sync:now";
    }

    internal sealed record SyncCode : IPageMessage
    {
        public static string Type => "sync:code";
    }

    internal sealed record SyncRotate : IPageMessage
    {
        public static string Type => "sync:rotate";
    }

    internal sealed record SyncOff : IPageMessage
    {
        public static string Type => "sync:off";
    }

    /// <summary>Unlocks history after a password reset with the recovery code.</summary>
    internal sealed record SecurityRecover(string? Code = null) : IPageMessage
    {
        public static string Type => "security:recover";
    }

    /// <summary>Sets the locked history aside and starts with a new key.</summary>
    internal sealed record SecurityStartFresh : IPageMessage
    {
        public static string Type => "security:startFresh";
    }

    /// <summary>The user saved the recovery code.</summary>
    internal sealed record SecuritySaved : IPageMessage
    {
        public static string Type => "security:saved";
    }

    internal sealed record SecurityCode : IPageMessage
    {
        public static string Type => "security:code";
    }

    internal sealed record SecurityRegenerate : IPageMessage
    {
        public static string Type => "security:regenerate";
    }

    /// <summary>Brings back history set aside by "Start fresh", with its recovery code.</summary>
    internal sealed record SecurityRestore(string? Code = null) : IPageMessage
    {
        public static string Type => "security:restore";
    }
}

internal static partial class ToPage
{
    internal sealed record RecStatus(string Id, string? Path) : IHostMessage
    {
        public static string Type => "rec:status";
    }

    internal sealed record RecFailed(string Id, string Error) : IHostMessage
    {
        public static string Type => "rec:status";

        public string? Path { get; }
    }

    /// <summary>A recording reached its size limit and stopped; <see cref="Full"/> is its file.</summary>
    internal sealed record RecFull(string Id, string Full) : IHostMessage
    {
        public static string Type => "rec:status";

        public string? Path { get; }
    }

    internal sealed record RecList(IReadOnlyList<RecordingFile> Items) : IHostMessage
    {
        public static string Type => "rec:list";
    }

    /// <summary>A recording's text for the player (js/replay.js).</summary>
    internal sealed record RecData(string Path, string Name, string Text) : IHostMessage
    {
        public static string Type => "rec:data";
    }

    internal sealed record RecDataFailed(string? Path, string Error) : IHostMessage
    {
        public static string Type => "rec:data";
    }

    /// <param name="Raw">The log keeps the terminal's bytes (escape sequences and all), not plain text.</param>
    internal sealed record LogStatus(string Id, string Path, bool Raw) : IHostMessage
    {
        public static string Type => "log:status";
    }

    internal sealed record LogStopped(string Id) : IHostMessage
    {
        public static string Type => "log:status";

        public string? Path { get; }
    }

    internal sealed record LogFailed(string Id, string Error) : IHostMessage
    {
        public static string Type => "log:status";

        public string? Path { get; }
    }

    internal sealed record CheckinStatus(bool Running, string? Url, string? Error, object Devices) : IHostMessage
    {
        public static string Type => "checkin:status";
    }

    /// <summary>The pairing link (as a QR code on the page): the server's address with a one-time key.</summary>
    internal sealed record CheckinPairing(string Url) : IHostMessage
    {
        public static string Type => "checkin:pairing";
    }

    /// <param name="Code">The sync code, when one is to be shown.</param>
    /// <param name="Rotated">The code was just changed (the other PCs need the new one).</param>
    internal sealed record SyncStatus(object Status, string? Code, bool Rotated, string? Message) : IHostMessage
    {
        public static string Type => "sync:status";
    }

    /// <summary>History can't be unlocked: the page asks for the recovery code first.</summary>
    internal sealed record SecurityLocked : IHostMessage
    {
        public static string Type => "security:locked";
    }

    internal sealed record SecurityError(string Message) : IHostMessage
    {
        public static string Type => "security:error";
    }

    internal sealed record RecoveryCode(string? Code) : IHostMessage
    {
        public static string Type => "security:code";
    }

    internal sealed record RegeneratedCode(string Code) : IHostMessage
    {
        public static string Type => "security:code";

        public bool Regenerated { get; } = true;
    }

    /// <param name="Count">How many archives were brought back.</param>
    /// <param name="Archives">How many are still set aside.</param>
    internal sealed record SecurityRestored(int Count, int Archives) : IHostMessage
    {
        public static string Type => "security:restored";
    }
}
