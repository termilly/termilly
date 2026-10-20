using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop;

/// <summary>Native glue for a window that draws its own title bar and control box in page content.</summary>
internal static class WindowInterop
{
    private const int GWL_STYLE = -16;
    private const int WS_SYSMENU = 0x00080000;
    private const int WS_CAPTION = 0x00C00000;
    private const int WM_GETMINMAXINFO = 0x0024;
    private const int WM_NCLBUTTONDOWN = 0x00A1;
    private const int WM_SETICON = 0x0080;
    private static readonly IntPtr ICON_SMALL = 0;
    private static readonly IntPtr ICON_BIG = 1;
    private const uint IMAGE_ICON = 1;
    private const uint LR_LOADFROMFILE = 0x0010;
    private const int MONITOR_DEFAULTTONEAREST = 2;

    public const int HTCAPTION = 2;
    private const int HTLEFT = 10, HTRIGHT = 11, HTTOP = 12, HTTOPLEFT = 13, HTTOPRIGHT = 14, HTBOTTOM = 15, HTBOTTOMLEFT = 16, HTBOTTOMRIGHT = 17;

    /// <summary>Hit-test codes for the page's resize edges.</summary>
    public static readonly IReadOnlyDictionary<string, int> EdgeHitTests = new Dictionary<string, int>
    {
        [ResizeEdges.West] = HTLEFT, [ResizeEdges.East] = HTRIGHT, [ResizeEdges.North] = HTTOP, [ResizeEdges.NorthWest] = HTTOPLEFT,
        [ResizeEdges.NorthEast] = HTTOPRIGHT, [ResizeEdges.South] = HTBOTTOM, [ResizeEdges.SouthWest] = HTBOTTOMLEFT, [ResizeEdges.SouthEast] = HTBOTTOMRIGHT,
    };

    /// <summary>The window's icon at the taskbar's size and the title bar's, in pixels at 100%.</summary>
    private const int BigIconSize = 24;
    private const int SmallIconSize = 16;
    /// <summary>Windows' DPI at 100%.</summary>
    /// <summary>Windows' DPI at 100% scale.</summary>
    public const double BaseDpi = 96.0;
    /// <summary>COLORREF packs red, green and blue as 0x00BBGGRR.</summary>
    private const int GreenShift = 8;
    private const int BlueShift = 16;

    /// <summary>
    /// Removes the native caption and control box (system menu) while keeping the thick frame and
    /// min/max styles, so snapping, taskbar minimize and maximize still work.
    /// </summary>
    public static void UseCustomChrome(Window window)
    {
        window.SourceInitialized += (_, _) =>
        {
            var hwnd = new WindowInteropHelper(window).Handle;
            _ = SetWindowLong(hwnd, GWL_STYLE, GetWindowLong(hwnd, GWL_STYLE) & ~(WS_SYSMENU | WS_CAPTION));
            HwndSource.FromHwnd(hwnd).AddHook(WndProc);
            SetSharpIcons(hwnd);
        };
        // WPF hands the window its own icons again when the display scale changes.
        window.DpiChanged += (_, _) => SetSharpIcons(new WindowInteropHelper(window).Handle);
    }

    private static IntPtr _bigIcon;
    private static IntPtr _smallIcon;

    /// <summary>
    /// Gives the window icons at exactly the sizes they are drawn at, so nothing gets rescaled. The taskbar
    /// draws the big icon at 24 px (at 100%), but Windows' default big icon is 32 px, which it shrinks and
    /// blurs; the .ico has hand-tuned frames for 16 to 48 px.
    /// </summary>
    private static void SetSharpIcons(IntPtr hwnd)
    {
        var path = Path.Combine(AppPaths.Assets, "termilly.ico");
        var dpi = GetDpiForWindow(hwnd);
        var big = LoadImage(IntPtr.Zero, path, IMAGE_ICON, Scale(BigIconSize, dpi), Scale(BigIconSize, dpi), LR_LOADFROMFILE);
        var small = LoadImage(IntPtr.Zero, path, IMAGE_ICON, Scale(SmallIconSize, dpi), Scale(SmallIconSize, dpi), LR_LOADFROMFILE);
        if (big == IntPtr.Zero || small == IntPtr.Zero)
        {
            return; // keep whatever Windows has rather than no icon
        }

        SendMessage(hwnd, WM_SETICON, ICON_BIG, big);
        SendMessage(hwnd, WM_SETICON, ICON_SMALL, small);
        if (_bigIcon != IntPtr.Zero)
        {
            DestroyIcon(_bigIcon);
        }
        if (_smallIcon != IntPtr.Zero)
        {
            DestroyIcon(_smallIcon);
        }
        (_bigIcon, _smallIcon) = (big, small);
    }

    private static int Scale(int size, uint dpi) => (int)Math.Round(size * dpi / BaseDpi);

    /// <summary>Starts the system move or size loop as if the user pressed the mouse on that part of the frame.</summary>
    public static void BeginNonClientDrag(Window window, int hitTest)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        ReleaseCapture();
        SendMessage(hwnd, WM_NCLBUTTONDOWN, (IntPtr)hitTest, IntPtr.Zero);
    }

    private const int WM_ERASEBKGND = 0x0014;

    /// <summary>
    /// The colour Windows paints the window with before WPF has drawn it (the theme's background), as #RRGGBB. Without
    /// it that first frame is white, a flash under the start-up screen.
    /// </summary>
    public static string Background { get; set; } = Black;

    private const string Black = "#000000";

    private static IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_ERASEBKGND)
        {
            var c = System.Drawing.ColorTranslator.FromHtml(Background);
            var brush = CreateSolidBrush(c.R | c.G << GreenShift | c.B << BlueShift);
            GetClientRect(hwnd, out var client);
            _ = FillRect(wParam, ref client, brush);
            DeleteObject(brush);
            handled = true;
            return 1;
        }
        if (msg == WM_GETMINMAXINFO)
        {
            // A captionless window would otherwise maximize over the taskbar.
            var monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
            if (monitor != IntPtr.Zero && GetMonitorInfo(monitor, ref info))
            {
                var mmi = Marshal.PtrToStructure<MINMAXINFO>(lParam);
                mmi.ptMaxPosition.X = info.rcWork.Left - info.rcMonitor.Left;
                mmi.ptMaxPosition.Y = info.rcWork.Top - info.rcMonitor.Top;
                mmi.ptMaxSize.X = info.rcWork.Right - info.rcWork.Left;
                mmi.ptMaxSize.Y = info.rcWork.Bottom - info.rcWork.Top;
                Marshal.StructureToPtr(mmi, lParam, false);
            }
        }
        return IntPtr.Zero;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MINMAXINFO
    {
        public POINT ptReserved;
        public POINT ptMaxSize;
        public POINT ptMaxPosition;
        public POINT ptMinTrackSize;
        public POINT ptMaxTrackSize;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public int dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool ReleaseCapture();

    [DllImport("user32.dll")]
    private static extern IntPtr SendMessage(IntPtr hWnd, int msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern int GetWindowLong(IntPtr hWnd, int index);

    [DllImport("user32.dll")]
    private static extern int SetWindowLong(IntPtr hWnd, int index, int value);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromWindow(IntPtr hwnd, int flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForWindow(IntPtr hwnd);

    [DllImport("gdi32.dll")]
    private static extern IntPtr CreateSolidBrush(int color);

    [DllImport("gdi32.dll")]
    private static extern bool DeleteObject(IntPtr obj);

    [DllImport("user32.dll")]
    private static extern bool GetClientRect(IntPtr hwnd, out ERASE_RECT rect);

    [DllImport("user32.dll")]
    private static extern int FillRect(IntPtr dc, ref ERASE_RECT rect, IntPtr brush);

    [StructLayout(LayoutKind.Sequential)]
    private struct ERASE_RECT
    {
        public int Left, Top, Right, Bottom;
    }

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr LoadImage(IntPtr hInstance, string name, uint type, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr hIcon);
}
