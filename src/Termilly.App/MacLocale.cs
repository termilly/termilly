using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// The LANG a macOS terminal starts with when nothing set a locale. An app opened from the Dock or Finder gets none
/// from macOS, so shells ran in the C locale and printed Chinese and other non-ASCII text as garbage; Terminal.app and
/// iTerm set LANG themselves from the user's language and region, and so does Termilly now. A locale the user set
/// (LC_ALL, LC_CTYPE or LANG, or a profile's own variables) is left alone.
/// </summary>
internal static class MacLocale
{
    /// <summary>The variables that already name a locale, most specific first.</summary>
    private static readonly string[] LocaleVariables = ["LC_ALL", "LC_CTYPE", "LANG"];
    /// <summary>The variable set, and what its locale ends with.</summary>
    public const string Variable = "LANG";
    private const string Utf8 = ".UTF-8";
    /// <summary>The locale used when the user's own has no UTF-8 form on this Mac.</summary>
    public const string Fallback = "en_US" + Utf8;
    /// <summary>Where macOS keeps its locales, one folder each (zh_CN.UTF-8).</summary>
    private const string LocaleFolder = "/usr/share/locale";

    /// <summary>
    /// The LANG to set: the system locale (<paramref name="systemLocale"/>, such as zh_CN, zh-Hans_CN or
    /// en_US@rg=gbzzzz) in its UTF-8 form when this Mac has it (<paramref name="exists"/>), else en_US.UTF-8. Null
    /// when <paramref name="environment"/> names a locale already.
    /// </summary>
    internal static string? LangFor(Func<string, string?> environment, string? systemLocale, Func<string, bool> exists)
    {
        if (LocaleVariables.Any(name => !string.IsNullOrEmpty(environment(name))))
        {
            return null;
        }
        // "@rg=..." (region override) and "@calendar=..." aren't part of a POSIX locale's name.
        var name = (systemLocale ?? "").Split('@')[0].Replace('-', '_');
        var candidate = name + Utf8;
        if (name.Length > 0 && exists(candidate))
        {
            return candidate;
        }
        // zh-Hans_CN (script and region) has no folder of its own: its language and region (zh_CN) may.
        var parts = name.Split('_');
        var languageRegion = parts.Length > 2 ? $"{parts[0]}_{parts[^1]}{Utf8}" : null;
        return languageRegion is not null && exists(languageRegion) ? languageRegion : Fallback;
    }

    /// <summary>This Mac's LANG for terminals, worked out once; null when Termilly was started with a locale.</summary>
    [SupportedOSPlatform("macos")]
    public static string? Lang => Computed.Value;

    [SupportedOSPlatform("macos")]
    private static readonly Lazy<string?> Computed = new(() =>
        LangFor(Environment.GetEnvironmentVariable, SystemLocale(), name => Directory.Exists(Path.Combine(LocaleFolder, name))));

    private const string CoreFoundation = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
    /// <summary>kCFStringEncodingUTF8.</summary>
    private const uint CfUtf8 = 0x08000100;
    /// <summary>Room for a locale identifier, which is short (zh-Hans_CN@calendar=chinese).</summary>
    private const int IdentifierBytes = 256;

    /// <summary>The user's language and region as macOS has it (System Settings), such as en_US or zh-Hans_CN.</summary>
    [SupportedOSPlatform("macos")]
    private static string? SystemLocale()
    {
        var locale = CFLocaleCopyCurrent();
        if (locale == IntPtr.Zero)
        {
            return null;
        }
        try
        {
            var buffer = new byte[IdentifierBytes];
            // The identifier belongs to the locale (CoreFoundation's get rule): not released here.
            return CFStringGetCString(CFLocaleGetIdentifier(locale), buffer, buffer.Length, CfUtf8)
                ? Encoding.UTF8.GetString(buffer, 0, Array.IndexOf(buffer, (byte)0) is var end and >= 0 ? end : buffer.Length)
                : null;
        }
        finally
        {
            CFRelease(locale);
        }
    }

    [DllImport(CoreFoundation)]
    private static extern IntPtr CFLocaleCopyCurrent();

    [DllImport(CoreFoundation)]
    private static extern IntPtr CFLocaleGetIdentifier(IntPtr locale);

    [DllImport(CoreFoundation)]
    [return: MarshalAs(UnmanagedType.U1)]
    private static extern bool CFStringGetCString(IntPtr text, byte[] buffer, nint size, uint encoding);

    [DllImport(CoreFoundation)]
    private static extern void CFRelease(IntPtr value);
}
