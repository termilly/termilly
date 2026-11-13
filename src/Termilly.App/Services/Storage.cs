using System.IO;
using System.Security.Cryptography;

namespace Termilly.Desktop.Services;

/// <summary>The errors reading and writing Termilly's files can meet, and running what may meet them.</summary>
internal static class Storage
{
    /// <summary>A file or folder that can't be read or written: missing, locked, or not allowed.</summary>
    public static bool IsFileError(Exception e) => e is IOException or UnauthorizedAccessException;

    /// <summary>
    /// Runs a save. Storage problems (or locked history) must not take a terminal down: the error is reported and the
    /// next save tries again.
    /// </summary>
    public static void Try(Action save)
    {
        try
        {
            save();
        }
        catch (Exception e) when (IsFileError(e) || e is CryptographicException or InvalidOperationException)
        {
            Console.Error.WriteLine($"termilly: couldn't save: {e.Message}");
        }
    }
}
