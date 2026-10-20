using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Threading;

namespace Termilly.Desktop;

/// <summary>
/// The drop-down ("quake") terminal: a global shortcut slides the window down from the top of the monitor under
/// the mouse, full width, always on top, and slides it away again (or when it loses focus, if autohide is on).
/// The window's normal place and size are kept and come back when the mode is turned off.
/// </summary>
internal sealed class QuakeMode
{
    private static readonly TimeSpan SlideTime = TimeSpan.FromMilliseconds(140);

    private readonly Window _window;
    private readonly Action<bool> _shown;
    private (Rect Bounds, WindowState State, Size Min)? _normal;
    private DispatcherTimer? _slide;

    /// <param name="shown">Called when the window has dropped down (true) or gone away (false).</param>
    public QuakeMode(Window window, Action<bool> shown)
    {
        _window = window;
        _shown = shown;
        window.Deactivated += (_, _) =>
        {
            if (AutoHide && IsDown)
            {
                SlideUp();
            }
        };
    }

    /// <summary>Height as a share of the monitor's work area, <see cref="MinHeight"/> to 1.</summary>
    public double Height { get; set; } = DefaultHeight;

    private const double DefaultHeight = 0.5;
    private const double MinHeight = 0.2;
    /// <summary>How often the slide moves the window.</summary>
    private static readonly TimeSpan SlideStep = TimeSpan.FromMilliseconds(10);
    /// <summary>The slide eases out as a cubic: fast at first, slowing into place.</summary>
    private const double EaseOutPower = 3;
    public bool AutoHide { get; set; } = true;

    /// <summary>Whether the window is in drop-down mode (down or hidden).</summary>
    public bool Active => _normal is not null;
    public bool IsDown => Active && _window.IsVisible && _slide is null;

    /// <summary>The shortcut: down if hidden or behind other windows, away if it's down and in front.</summary>
    public void Toggle()
    {
        if (IsDown && _window.IsActive)
        {
            SlideUp();
        }
        else
        {
            SlideDown();
        }
    }

    /// <summary>Leaves drop-down mode: the window returns to where it was, as a normal window.</summary>
    public void Leave()
    {
        if (_normal is not { } normal)
        {
            return;
        }
        _slide?.Stop();
        _slide = null;
        _normal = null;
        _window.Topmost = false;
        _window.MinWidth = normal.Min.Width;
        _window.MinHeight = normal.Min.Height;
        _window.Left = normal.Bounds.Left;
        _window.Top = normal.Bounds.Top;
        _window.Width = normal.Bounds.Width;
        _window.Height = normal.Bounds.Height;
        _window.WindowState = normal.State;
        _window.Show();
        _window.Activate();
    }

    private void SlideDown()
    {
        if (_normal is null)
        {
            _normal = (new Rect(_window.Left, _window.Top, _window.Width, _window.Height), _window.WindowState,
                new Size(_window.MinWidth, _window.MinHeight));
            // Down, the window can be shorter than a normal window may be (a fifth of the screen).
            _window.MinHeight = 0;
        }
        var area = WorkAreaUnderCursor();
        var height = (int)Math.Round(area.Height * Math.Clamp(Height, MinHeight, 1));
        var hwnd = new WindowInteropHelper(_window).EnsureHandle();

        _window.WindowState = WindowState.Normal;
        _window.Topmost = true;
        SetWindowPos(hwnd, IntPtr.Zero, area.Left, area.Top - height, area.Width, height, SWP_NOZORDER | SWP_NOACTIVATE);
        _window.Show();
        _window.Activate();
        Animate(hwnd, new Slide(area.Left, area.Width, height, area.Top - height, area.Top), () => _shown(true));
    }

    private void SlideUp()
    {
        var hwnd = new WindowInteropHelper(_window).Handle;
        GetWindowRect(hwnd, out var rect);
        var height = rect.Bottom - rect.Top;
        Animate(hwnd, new Slide(rect.Left, rect.Right - rect.Left, height, rect.Top, rect.Top - height), () =>
        {
            _window.Hide();
            _shown(false);
        });
    }

    /// <summary>A slide of the window: where it is across and its size, and the top edges it moves between (physical pixels).</summary>
    private readonly record struct Slide(int Left, int Width, int Height, int FromTop, int ToTop);

    /// <summary>A monitor's work area (the screen minus the taskbar), in physical pixels.</summary>
    private readonly record struct WorkArea(int Left, int Top, int Width, int Height);

    /// <summary>Moves the window vertically from one top edge to another.</summary>
    private void Animate(IntPtr hwnd, Slide slide, Action done)
    {
        _slide?.Stop();
        if (!SystemParameters.ClientAreaAnimation)
        {
            SetWindowPos(hwnd, IntPtr.Zero, slide.Left, slide.ToTop, slide.Width, slide.Height, SWP_NOZORDER | SWP_NOACTIVATE);
            _slide = null;
            done();
            return;
        }
        var start = DateTime.UtcNow;
        var timer = new DispatcherTimer(DispatcherPriority.Render) { Interval = SlideStep };
        _slide = timer;
        timer.Tick += (_, _) =>
        {
            var t = Math.Min(1, (DateTime.UtcNow - start) / SlideTime);
            var eased = 1 - Math.Pow(1 - t, EaseOutPower);
            SetWindowPos(hwnd, IntPtr.Zero, slide.Left, (int)Math.Round(slide.FromTop + (slide.ToTop - slide.FromTop) * eased), slide.Width, slide.Height, SWP_NOZORDER | SWP_NOACTIVATE);
            if (t >= 1)
            {
                timer.Stop();
                _slide = null;
                done();
            }
        };
        timer.Start();
    }

    /// <summary>The work area (screen minus taskbar) of the monitor the mouse is on, in physical pixels.</summary>
    private static WorkArea WorkAreaUnderCursor()
    {
        GetCursorPos(out var point);
        var monitor = MonitorFromPoint(point, MONITOR_DEFAULTTONEAREST);
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(monitor, ref info);
        var r = info.rcWork;
        return new(r.Left, r.Top, r.Right - r.Left, r.Bottom - r.Top);
    }

    private const uint SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10;
    private const uint MONITOR_DEFAULTTONEAREST = 2;

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [DllImport("user32.dll")]
    private static extern bool GetCursorPos(out POINT point);

    [DllImport("user32.dll")]
    private static extern IntPtr MonitorFromPoint(POINT point, uint flags);

    [DllImport("user32.dll")]
    private static extern bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    [DllImport("user32.dll")]
    private static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
}
