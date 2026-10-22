namespace Termilly.Desktop.Services;

/// <summary>The media types Termilly serves files with (Linux's app:// page), and the extensions they go by.</summary>
internal static class MediaTypes
{
    public const string PlainText = "text/plain";
    public const string Html = "text/html";
    public const string JavaScript = "text/javascript";
    public const string Css = "text/css";
    public const string Json = "application/json";
    public const string Manifest = "application/manifest+json";
    public const string Svg = "image/svg+xml";
    public const string Png = "image/png";
    public const string Icon = "image/x-icon";
    public const string Woff2 = "font/woff2";
    public const string Woff = "font/woff";
    public const string Ttf = "font/ttf";
    public const string Binary = "application/octet-stream";

    /// <summary>A text type with its character set: UTF-8.</summary>
    public static string Utf8(string type) => type + "; charset=utf-8";

    public static class Extensions
    {
        public const string Html = ".html";
        public const string JavaScript = ".js";
        public const string Module = ".mjs";
        public const string Css = ".css";
        public const string Json = ".json";
        public const string Manifest = ".webmanifest";
        public const string Svg = ".svg";
        public const string Png = ".png";
        public const string Icon = ".ico";
        public const string Woff2 = ".woff2";
        public const string Woff = ".woff";
        public const string Ttf = ".ttf";
        public const string Text = ".txt";
    }
}
