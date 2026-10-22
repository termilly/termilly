using System.Runtime.InteropServices;
using System.Windows.Interop;

namespace Termilly.Desktop;

/// <summary>
/// Termilly's icon in the notification area (the tray), there while the window is hidden in it (Settings › Workspaces ›
/// Minimize and Close): a click brings Termilly back, and its menu can also quit. WPF has no tray icon, so this is
/// Shell_NotifyIcon on a message-only window of its own. The icon is loaded at the tray's exact size, so it stays sharp.
/// </summary>
internal sealed class TrayIcon : IDisposable
{
    private const int CallbackMessage = WM_APP + 1;
    private const uint IconId = 1;
    private const uint ShowCommand = 1;
    private const uint QuitCommand = 2;
    private const string ShowLabel = "Show Termilly";
    private const string QuitLabel = "Quit Termilly";

    private readonly Action _show;
    private readonly Action _quit;
    private readonly HwndSource _messages;
    /// <summary>Explorer says this when it starts again (after a crash): the icon has to be added anew.</summary>
    private readonly uint _taskbarCreated = RegisterWindowMessage("TaskbarCreated");
    private IntPtr _icon;
    private string _tip = Product.Name;
    private bool _shown;

    /// <param name="show">A click on the icon, or Show in its menu.</param>
    /// <param name="quit">Quit in its menu.</param>
    public TrayIcon(Action show, Action quit)
    {
        (_show, _quit) = (show, quit);
        _messages = new HwndSource(new HwndSourceParameters(nameof(TrayIcon)) { ParentWindow = HWND_MESSAGE, WindowStyle = 0 });
        _messages.AddHook(WndProc);
    }

    /// <summary>Shows the icon (while the window is hidden).</summary>
    public void Show()
    {
        if (_shown)
        {
            return;
        }
        _icon = LoadIcon();
        var data = Data(NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP);
        _shown = Shell_NotifyIcon(NIM_ADD, ref data);
        if (_shown)
        {
            data.uVersion = NOTIFYICON_VERSION_4;
            Shell_NotifyIcon(NIM_SETVERSION, ref data);
        }
    }

    /// <summary>Takes the icon away (the window is back).</summary>
    public void Hide()
    {
        if (!_shown)
        {
            return;
        }
        var data = Data(0);
        Shell_NotifyIcon(NIM_DELETE, ref data);
        _shown = false;
        if (_icon != IntPtr.Zero)
        {
            DestroyIcon(_icon);
            _icon = IntPtr.Zero;
        }
    }

    /// <summary>The icon's tooltip: Termilly, and how many terminals need you.</summary>
    public void SetTip(string tip)
    {
        _tip = tip;
        if (_shown)
        {
            var data = Data(NIF_TIP | NIF_SHOWTIP);
            Shell_NotifyIcon(NIM_MODIFY, ref data);
        }
    }

    public void Dispose()
    {
        Hide();
        _messages.RemoveHook(WndProc);
        _messages.Dispose();
    }

    private NOTIFYICONDATA Data(uint flags) => new()
    {
        cbSize = Marshal.SizeOf<NOTIFYICONDATA>(),
        hWnd = _messages.Handle,
        uID = IconId,
        uFlags = flags,
        uCallbackMessage = CallbackMessage,
        hIcon = _icon,
        szTip = _tip.Length < MaxTip ? _tip : _tip[..(MaxTip - 1)],
    };

    private static IntPtr LoadIcon()
    {
        var dpi = GetDpiForSystem();
        var size = GetSystemMetricsForDpi(SM_CXSMICON, dpi);
        return LoadImage(IntPtr.Zero, AppPaths.IconFile, IMAGE_ICON, size, size, LR_LOADFROMFILE);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == _taskbarCreated && _shown)
        {
            _shown = false;
            Show();
        }
        else if (msg == CallbackMessage)
        {
            // With NOTIFYICON_VERSION_4 the event is in lParam's low word, and wParam holds where it happened.
            switch (lParam.ToInt32() & LowWord)
            {
                case NIN_SELECT:
                case NIN_KEYSELECT:
                    _show();
                    break;
                case WM_CONTEXTMENU:
                    ShowMenu(hwnd, (short)(wParam.ToInt32() & LowWord), (short)(wParam.ToInt32() >> HighWordShift));
                    break;
            }
            handled = true;
        }
        return IntPtr.Zero;
    }

    private void ShowMenu(IntPtr hwnd, int x, int y)
    {
        var menu = CreatePopupMenu();
        try
        {
            AppendMenu(menu, MF_STRING, ShowCommand, ShowLabel);
            AppendMenu(menu, MF_SEPARATOR, 0, null);
            AppendMenu(menu, MF_STRING, QuitCommand, QuitLabel);
            SetMenuDefaultItem(menu, ShowCommand, 0);
            // Without this the menu stays open when the user clicks elsewhere.
            SetForegroundWindow(hwnd);
            var command = TrackPopupMenuEx(menu, TPM_RETURNCMD | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, x, y, hwnd, IntPtr.Zero);
            if (command == ShowCommand)
            {
                _show();
            }
            else if (command == QuitCommand)
            {
                _quit();
            }
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private const int WM_APP = 0x8000;
    private const int WM_CONTEXTMENU = 0x007B;
    private const int NIN_SELECT = 0x0400;
    private const int NIN_KEYSELECT = 0x0401;
    private const int LowWord = 0xFFFF;
    private const int HighWordShift = 16;
    private const uint NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2, NIM_SETVERSION = 4;
    private const uint NIF_MESSAGE = 0x1, NIF_ICON = 0x2, NIF_TIP = 0x4, NIF_SHOWTIP = 0x80;
    private const uint NOTIFYICON_VERSION_4 = 4;
    /// <summary>szTip's length, its last character the terminating zero.</summary>
    private const int MaxTip = 128;
    private const uint MF_STRING = 0, MF_SEPARATOR = 0x800;
    private const uint TPM_RIGHTBUTTON = 0x2, TPM_BOTTOMALIGN = 0x20, TPM_RETURNCMD = 0x100;
    private const int SM_CXSMICON = 49;
    private const uint IMAGE_ICON = 1;
    private const uint LR_LOADFROMFILE = 0x10;
    private static readonly IntPtr HWND_MESSAGE = new(-3);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATA
    {
        public int cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public int uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MaxTip)]
        public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        public string szInfo;
        public uint uVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)]
        public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, EntryPoint = "Shell_NotifyIconW")]
    private static extern bool Shell_NotifyIcon(uint message, ref NOTIFYICONDATA data);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "RegisterWindowMessageW")]
    private static extern uint RegisterWindowMessage(string name);

    [DllImport("user32.dll")]
    private static extern IntPtr CreatePopupMenu();

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "AppendMenuW")]
    private static extern bool AppendMenu(IntPtr menu, uint flags, uint id, string? text);

    [DllImport("user32.dll")]
    private static extern bool SetMenuDefaultItem(IntPtr menu, uint item, uint byPosition);

    [DllImport("user32.dll")]
    private static extern uint TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hwnd, IntPtr parameters);

    [DllImport("user32.dll")]
    private static extern bool DestroyMenu(IntPtr menu);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr hwnd);

    [DllImport("user32.dll")]
    private static extern uint GetDpiForSystem();

    [DllImport("user32.dll")]
    private static extern int GetSystemMetricsForDpi(int index, uint dpi);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "LoadImageW")]
    private static extern IntPtr LoadImage(IntPtr instance, string name, uint type, int cx, int cy, uint load);

    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr icon);
}
