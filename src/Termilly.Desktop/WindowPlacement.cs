using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// Where the window was and whether it was maximized, kept in window.json in the data folder and put back the
/// next time Termilly opens. All in Windows' own screen pixels, so it's right on every monitor and scale; a place
/// whose monitor is gone moves onto one that's there. A window closed minimized opens as it was before.
/// </summary>
internal static class WindowPlacement
{
    private const int SW_HIDE = 0;
    private const int SW_SHOWMINIMIZED = 2;
    private const int SW_SHOWMAXIMIZED = 3;
    private const int WPF_RESTORETOMAXIMIZED = 2;
    private const int MONITOR_DEFAULTTONEAREST = 2;
    private const int MONITOR_DEFAULTTOPRIMARY = 1;
    /// <summary>A first start's size, in pixels at 100%.</summary>
    private const int FirstWidth = 1180;
    private const int FirstHeight = 720;
    /// <summary>A saved place smaller than this is ignored (a damaged file, or a window too small to use).</summary>
    private const int MinSavedWidth = 200;
    private const int MinSavedHeight = 150;
    /// <summary>Windows' DPI at 100%, and the scale when a monitor's isn't known.</summary>
    private const double NoScale = 1.0;

    public static string File { get; } = Path.Combine(AppPaths.DataDirectory, "window.json");

    /// <summary>The saved place, as stored.</summary>
    public sealed record Saved(int Left, int Top, int Right, int Bottom, bool Maximized);

    /// <summary>
    /// Where the window ends up: its normal place, whether it's maximized, the work area it's on, and that monitor's
    /// scale (screen pixels per WPF unit).
    /// </summary>
    public sealed record Target(Int32Rect Normal, bool Maximized, Int32Rect WorkArea, double Scale)
    {
        /// <summary>The window's final place on screen: the work area when maximized.</summary>
        public Int32Rect Final => Maximized ? WorkArea : Normal;
    }

    /// <summary>
    /// The saved place, no smaller than <paramref name="minimum"/> (WPF units), or a first start's: 1180x720, no bigger
    /// than the work area, centred on the main monitor.
    /// </summary>
    public static Target Plan(Size minimum, string? file = null)
    {
        if (Read(file ?? File) is { } saved)
        {
            var normal = new RECT { Left = saved.Left, Top = saved.Top, Right = saved.Right, Bottom = saved.Bottom };
            var (work, scale) = Monitor(MonitorFromRect(ref normal, MONITOR_DEFAULTTONEAREST));
            return new Target(OnScreen(normal, work, minimum, scale), saved.Maximized, work, scale);
        }
        var (primary, s) = Monitor(MonitorFromPoint(new POINT(), MONITOR_DEFAULTTOPRIMARY));
        var width = Math.Min((int)Math.Round(FirstWidth * s), primary.Width);
        var height = Math.Min((int)Math.Round(FirstHeight * s), primary.Height);
        return new Target(new Int32Rect(primary.X + (primary.Width - width) / 2, primary.Y + (primary.Height - height) / 2, width, height),
            false, primary, s);
    }

    /// <summary>
    /// A normal place grown to the minimum size (a window closed smaller than that, before there was one), then moved
    /// (and shrunk, if need be) to lie within the work area.
    /// </summary>
    private static Int32Rect OnScreen(RECT r, Int32Rect work, Size minimum, double scale)
    {
        var width = Math.Min(Math.Max(r.Right - r.Left, (int)Math.Ceiling(minimum.Width * scale)), work.Width);
        var height = Math.Min(Math.Max(r.Bottom - r.Top, (int)Math.Ceiling(minimum.Height * scale)), work.Height);
        var left = Math.Clamp(r.Left, work.X, work.X + work.Width - width);
        var top = Math.Clamp(r.Top, work.Y, work.Y + work.Height - height);
        return new Int32Rect(left, top, width, height);
    }

    /// <summary>
    /// Puts the window, created but not yet shown, in its target place while it's still hidden, maximized (through
    /// WPF's own state) if it was, so it first appears where it belongs, drawn.
    /// </summary>
    public static void Restore(Window window, Target target)
    {
        var n = target.Normal;
        var placement = new WINDOWPLACEMENT
        {
            length = Marshal.SizeOf<WINDOWPLACEMENT>(),
            showCmd = SW_HIDE,
            rcNormalPosition = new RECT { Left = n.X, Top = n.Y, Right = n.X + n.Width, Bottom = n.Y + n.Height },
        };
        SetWindowPlacement(new WindowInteropHelper(window).Handle, ref placement);
        if (target.Maximized)
        {
            window.WindowState = WindowState.Maximized;
        }
    }

    /// <summary>Remembers where the window is now; called as it closes.</summary>
    public static void Save(Window window, string? file = null)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        var placement = new WINDOWPLACEMENT { length = Marshal.SizeOf<WINDOWPLACEMENT>() };
        if (hwnd == IntPtr.Zero || !GetWindowPlacement(hwnd, ref placement))
        {
            return;
        }
        var maximized = placement.showCmd == SW_SHOWMAXIMIZED
            || (placement.showCmd == SW_SHOWMINIMIZED && (placement.flags & WPF_RESTORETOMAXIMIZED) != 0);
        var r = placement.rcNormalPosition;
        Write(file ?? File, new Saved(r.Left, r.Top, r.Right, r.Bottom, maximized));
    }

    public static Saved? Read(string file)
    {
        try
        {
            var saved = JsonSerializer.Deserialize<Saved>(System.IO.File.ReadAllText(file));
            // A window too small to use (or a damaged file) is ignored rather than restored.
            return saved is not null && saved.Right - saved.Left >= MinSavedWidth && saved.Bottom - saved.Top >= MinSavedHeight ? saved : null;
        }
        catch (Exception e) when (Storage.IsFileError(e) || e is JsonException)
        {
            return null;
        }
    }

    public static void Write(string file, Saved saved)
    {
        try
        {
            AppPaths.WriteAtomically(file, JsonSerializer.Serialize(saved));
        }
        catch (Exception e) when (Storage.IsFileError(e))
        {
        }
    }

    /// <summary>A monitor's work area (without the taskbar) and its scale.</summary>
    private static (Int32Rect Work, double Scale) Monitor(IntPtr monitor)
    {
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(monitor, ref info);
        var w = info.rcWork;
        var scale = GetDpiForMonitor(monitor, 0, out var dpi, out _) == 0 ? dpi / WindowInterop.BaseDpi : NoScale;
        return (new Int32Rect(w.Left, w.Top, w.Right - w.Left, w.Bottom - w.Top), scale);
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X, Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct WINDOWPLACEMENT
    {
        public int length;
        public int flags;
        public int showCmd;
        public POINT ptMinPosition;
        public POINT ptMaxPosition;
        public RECT rcNormalPosition;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool GetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool SetWindowPlacement(IntPtr hWnd, ref WINDOWPLACEMENT lpwndpl);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromRect(ref RECT rect, int flags);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT point, int flags);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("shcore.dll")]
    private static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint dpiX, out uint dpiY);
}
