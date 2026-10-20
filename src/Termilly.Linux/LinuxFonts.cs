using System.IO;
using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>The fonts installed on Linux, from fontconfig.</summary>
internal sealed class LinuxFonts(IProcessRunner runner) : IFontCatalog
{
    private const string FcList = "fc-list";
    private static readonly TimeSpan Timeout = TimeSpan.FromSeconds(5);

    public InstalledFonts Read()
    {
        var all = Families(":style=Regular family");
        var mono = Families(":spacing=mono family");
        var bold = Families(":spacing=mono:weight=bold family");
        mono.IntersectWith(all.Count > 0 ? all : mono);
        bold.IntersectWith(mono);
        return new InstalledFonts([.. all], [.. mono], [.. bold]);
    }

    /// <summary>The families fc-list lists for a pattern; a family can list localised names after a comma.</summary>
    private SortedSet<string> Families(string pattern)
    {
        string output;
        try
        {
            output = runner.Run(new ProcessRequest(FcList, pattern.Split(' ')) { Timeout = Timeout }).Text;
        }
        catch (IOException)
        {
            output = ""; // no fontconfig
        }
        return new(
            output.Split('\n', StringSplitOptions.RemoveEmptyEntries).Select(line => line.Split(',')[0].Trim()).Where(name => name.Length > 0),
            StringComparer.OrdinalIgnoreCase);
    }
}
