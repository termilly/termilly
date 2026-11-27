namespace Termilly.Desktop.Features;

/// <summary>
/// The names on another Termilly's live connection (its phone server's, Phone/PhoneLive.cs): the fields of its messages
/// and their kinds, for its state connection (RemotePcsHandler) and its terminals' watches (RemoteWatches).
/// </summary>
internal static class PcWire
{
    public static class Fields
    {
        public const string Type = "type";
        public const string Op = "op";
        public const string Pane = "pane";
        public const string Data = "data";
        public const string Cols = "cols";
        public const string Rows = "rows";
        public const string State = "state";
        public const string Ok = "ok";
        public const string Error = "error";
    }

    public static class Kinds
    {
        public const string State = "state";
        public const string Screen = "screen";
        public const string Output = "output";
        public const string Answered = "answered";
        public const string Watch = "watch";
        public const string Input = "input";
        public const string Size = "size";
        public const string Refresh = "refresh";
        public const string Manage = "manage";
    }
}
