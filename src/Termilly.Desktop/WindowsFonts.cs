using System.IO;
using System.Windows;
using System.Windows.Media;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>The fonts installed on Windows, from WPF's view of them (one pass, since reading every font is slow).</summary>
internal sealed class WindowsFonts : IFontCatalog
{
    /// <summary>Bold enough to be a real bold face (OpenType weight).</summary>
    private const int BoldWeight = 600;
    /// <summary>How close two advance widths must be to count as the same.</summary>
    private const double SameWidth = 0.001;

    /// <summary>Symbol fonts are left out; a font is monospace when its 'i' and 'M' have the same advance width.</summary>
    public InstalledFonts Read()
    {
        var all = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var mono = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        var realBold = new SortedSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var family in Fonts.SystemFontFamilies)
        {
            try
            {
                var typeface = family.GetTypefaces().FirstOrDefault();
                if (typeface is null || !typeface.TryGetGlyphTypeface(out var glyphs) || glyphs.Symbol)
                {
                    continue;
                }

                all.Add(family.Source);
                if (glyphs.CharacterToGlyphMap.TryGetValue('i', out var i) &&
                    glyphs.CharacterToGlyphMap.TryGetValue('M', out var m) &&
                    Math.Abs(glyphs.AdvanceWidths[i] - glyphs.AdvanceWidths[m]) < SameWidth)
                {
                    mono.Add(family.Source);
                    if (family.GetTypefaces().Any(t => t.Weight.ToOpenTypeWeight() >= BoldWeight && !t.IsBoldSimulated && t.Style == FontStyles.Normal))
                    {
                        realBold.Add(family.Source);
                    }
                }
            }
            catch (Exception e) when (Storage.IsFileError(e) || e is FileFormatException)
            {
                // Broken or inaccessible font files are skipped.
            }
        }
        return new InstalledFonts([.. all], [.. mono], [.. realBold]);
    }
}
