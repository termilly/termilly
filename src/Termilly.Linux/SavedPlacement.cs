using System.Text.Json;
using Termilly.Desktop;
using Termilly.Desktop.Services;

namespace Termilly.Linux;

/// <summary>
/// window.json in the data folder (as the Windows build keeps its own there): the main window's normal frame, the one it
/// comes back to from maximized, and whether it was maximized. Read and written for <see cref="MacPlacement"/> and
/// <see cref="LinuxPlacement"/>, each in its system's units.
/// </summary>
internal static class SavedPlacement
{
    /// <summary>The window's normal frame, and whether it was maximized.</summary>
    internal sealed record Saved(double X, double Y, double Width, double Height, bool Maximized);

    /// <summary>A saved frame smaller than this is ignored (a damaged file, or a window too small to use).</summary>
    private const double MinSavedWidth = 200;
    private const double MinSavedHeight = 150;

    private static string File => AppPaths.WindowFile;

    /// <summary>What was saved, or null with nothing usable there.</summary>
    public static Saved? Read()
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Saved>(System.IO.File.ReadAllText(File));
            return saved is not null && saved.Width >= MinSavedWidth && saved.Height >= MinSavedHeight ? saved : null;
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            return null;
        }
    }

    public static void Write(Saved saved)
    {
        try
        {
            AppPaths.WriteAtomically(File, JsonSerializer.Serialize(saved));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
            // Not remembered this time: it opens where it always does.
        }
    }
}
