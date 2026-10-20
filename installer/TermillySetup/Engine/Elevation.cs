using System.ComponentModel;
using System.Diagnostics;
using System.Security.Principal;

namespace Termilly.Setup.Engine;

/// <summary>Running as administrator, and restarting setup that way for an "All users" install or uninstall.</summary>
internal static class Elevation
{
    public static bool IsElevated
    {
        get
        {
            using var identity = WindowsIdentity.GetCurrent();
            return new WindowsPrincipal(identity).IsInRole(WindowsBuiltInRole.Administrator);
        }
    }

    /// <summary>Starts setup again as administrator with <paramref name="arguments"/>; null when the prompt was declined.</summary>
    public static Process? Restart(string arguments)
    {
        var start = new ProcessStartInfo(SetupApp.ExePath, arguments) { UseShellExecute = true, Verb = WindowsNames.RunAs };
        try
        {
            Log.Write($"restarting as administrator: {arguments}");
            return Process.Start(start);
        }
        catch (Win32Exception e) when (e.NativeErrorCode == WindowsCodes.Cancelled)
        {
            Log.Write("the administrator prompt was declined");
            return null;
        }
    }

    /// <summary>Quotes one command-line argument.</summary>
    public static string Quote(string value) => "\"" + value.Replace("\"", "\\\"") + "\"";
}
