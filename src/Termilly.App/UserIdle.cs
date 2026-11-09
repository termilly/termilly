using System.Runtime.InteropServices;

namespace Termilly.Desktop;

/// <summary>
/// How long since the user last touched the keyboard or mouse, anywhere on the PC: so phone alerts can go out while
/// they're away (Settings › Phone). Windows only for now; elsewhere it's unknown (null).
/// </summary>
internal static class UserIdle
{
    public static TimeSpan? Since()
    {
        if (!OperatingSystem.IsWindows())
        {
            return null;
        }
        var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
        return GetLastInputInfo(ref info) ? TimeSpan.FromMilliseconds(unchecked((uint)Environment.TickCount - info.Time)) : null;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint Size;
        public uint Time;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);
}
