using System.Text.RegularExpressions;

namespace Termilly.Desktop.Features;

/// <summary>
/// Claude Code writes text the user pasted wrapped in tags of its own; the prompt is what's inside them.
/// </summary>
internal static partial class PastedText
{
    private const string Open = "<pasted_content";

    /// <summary>Whether the prompt starts with pasted text (so its first tag is the paste's, not a note's).</summary>
    public static bool Leads(string text) => text.StartsWith(Open, StringComparison.Ordinal);

    /// <summary>The prompt without the tags around pasted text (the text itself stays).</summary>
    public static string Unwrap(string text) => PastedTag().Replace(text, "").Trim();

    [GeneratedRegex("</?pasted_content[^>]*>")]
    private static partial Regex PastedTag();
}
