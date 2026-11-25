using System;
using System.IO;
using System.Threading;

namespace Termilly.Shared;

/// <summary>
/// Whether this program is the only one of its kind running (the app per data folder, the background host per user):
/// a named mutex on Windows, elsewhere an open, locked file (FileShare.None takes an flock), which the system lets go
/// of when the program exits, however it ends. Held for as long as the returned object is.
/// </summary>
internal static class SingleInstance
{
    /// <param name="windowsName">The mutex's name on Windows ("Local\…" or "Global\…").</param>
    /// <param name="lockFile">The file locked elsewhere; its folder is made if it isn't there.</param>
    /// <param name="first">False only when another one surely holds it; when it can't be told, true.</param>
    public static IDisposable? Claim(string windowsName, string lockFile, out bool first)
    {
        if (OperatingSystem.IsWindows())
        {
            try
            {
                return new Mutex(initiallyOwned: true, windowsName, out first);
            }
            catch (Exception e) when (e is UnauthorizedAccessException or WaitHandleCannotBeOpenedException or IOException)
            {
                first = true; // can't tell: start as before
                return null;
            }
        }
        return LockFile(lockFile, out first);
    }

    private static FileStream? LockFile(string path, out bool first)
    {
        first = true;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path))!);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return null; // can't tell: start as before
        }
        try
        {
            return new FileStream(path, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.None);
        }
        catch (UnauthorizedAccessException)
        {
            return null;
        }
        catch (IOException)
        {
            first = false; // another one holds it
            return null;
        }
    }
}
