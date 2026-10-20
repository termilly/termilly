using System.Text;
using Termilly.Desktop;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>The app:// scheme the Linux window loads its page from: the files in the app's wwwroot, nothing outside it.</summary>
internal static class AppScheme
{
    public const string Scheme = "app";
    public const string IndexPage = "index.html";
    private static readonly string Root = AppPaths.WebRoot;

    /// <summary>Each file extension wwwroot has, and the media type it's served as.</summary>
    private static readonly Dictionary<string, string> Types = new(StringComparer.OrdinalIgnoreCase) {
        [MediaTypes.Extensions.Html] = MediaTypes.Html, [MediaTypes.Extensions.JavaScript] = MediaTypes.JavaScript,
        [MediaTypes.Extensions.Module] = MediaTypes.JavaScript, [MediaTypes.Extensions.Css] = MediaTypes.Css,
        [MediaTypes.Extensions.Json] = MediaTypes.Json, [MediaTypes.Extensions.Svg] = MediaTypes.Svg,
        [MediaTypes.Extensions.Png] = MediaTypes.Png, [MediaTypes.Extensions.Icon] = MediaTypes.Icon,
        [MediaTypes.Extensions.Woff2] = MediaTypes.Woff2, [MediaTypes.Extensions.Woff] = MediaTypes.Woff,
        [MediaTypes.Extensions.Ttf] = MediaTypes.Ttf, [MediaTypes.Extensions.Text] = MediaTypes.PlainText,
    };

    /// <summary>
    /// A file from wwwroot for app://localhost/…, or nothing for anything outside it. The page comes with the theme
    /// already on it, so a light theme doesn't start with a dark loader (the Windows window colours its own): its
    /// light or dark base, and the loader's background, text and caret colours.
    /// </summary>
    public static Stream? Serve(string url, ThemeWindowColors colors, out string contentType)
    {
        contentType = MediaTypes.PlainText;
        var path = Uri.TryCreate(url, UriKind.Absolute, out var uri) ? Uri.UnescapeDataString(uri.AbsolutePath).TrimStart('/') : "";
        var file = Path.GetFullPath(Path.Combine(Root, path.Length == 0 ? IndexPage : path));
        if (!file.StartsWith(Root + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !File.Exists(file))
        {
            return null;
        }
        contentType = Types.GetValueOrDefault(Path.GetExtension(file), MediaTypes.Binary);
        if (file == Path.Combine(Root, IndexPage))
        {
            var page = File.ReadAllText(file).Replace("<html>", $"<html data-theme=\"{(colors.Light ? "light" : "dark")}\" style=\"--bg:{colors.Background};--text:{colors.Text};--accent:{colors.Accent}\">");
            return new MemoryStream(Encoding.UTF8.GetBytes(page));
        }
        return File.OpenRead(file);
    }
}
