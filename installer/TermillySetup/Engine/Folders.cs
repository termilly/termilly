using System;
using System.IO;
using System.Linq;
using System.Threading;
using Termilly.Shared;

namespace Termilly.Setup.Engine;

/// <summary>Folders setup works with: Termilly's data folder, and removing and measuring a folder.</summary>
internal static class Folders
{
    /// <summary>Tries at removing a folder that's in use (an exe still closing), and the wait between them.</summary>
    private const int Retries = 3;
    public const int UninstallRetries = 10;
    private const int RetryDelayMs = 500;

    /// <summary>Termilly's settings, workspaces and history (this user's).</summary>
    public static string Data => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), Product.Name);

    public static void Delete(string dir, int retries = Retries)
    {
        for (var attempt = 1; Directory.Exists(dir); attempt++)
        {
            try
            {
                foreach (var file in Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories))
                {
                    File.SetAttributes(file, FileAttributes.Normal);
                }
                Directory.Delete(dir, recursive: true);
                Log.Write($"removed {dir}");
            }
            catch (Exception e) when ((e is IOException or UnauthorizedAccessException) && attempt < retries)
            {
                Thread.Sleep(RetryDelayMs);
            }
            catch (Exception e) when (e is IOException or UnauthorizedAccessException)
            {
                Log.Write($"couldn't remove {dir}: {e.Message}");
                return;
            }
        }
    }

    public static double SizeMb(string dir)
    {
        try
        {
            return Directory.EnumerateFiles(dir, "*", SearchOption.AllDirectories).Sum(f => new FileInfo(f).Length) / Bytes.PerMb;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }
}
