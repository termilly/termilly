using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;

namespace Termilly.Desktop;

/// <summary>
/// System-wide shortcuts (RegisterHotKey): they work while another app has focus. Each runs its action on the UI
/// thread. Chords are written like "Ctrl+Alt+J"; a chord another app already owns can't be registered.
/// </summary>
internal sealed class GlobalHotkeys : IDisposable
{
    private const int WM_HOTKEY = 0x0312;
    private const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_SHIFT = 0x4, MOD_WIN = 0x8, MOD_NOREPEAT = 0x4000;
    /// <summary>Virtual-key codes: Space, the backtick key (OEM_3 on US layouts) and F1 (F2..F24 follow it).</summary>
    private const uint VK_SPACE = 0x20, VK_OEM_3 = 0xC0, VK_F1 = 0x70;
    private const int LastFunctionKey = 24;
    /// <summary>Hotkey ids start here, clear of any the app's other code might register.</summary>
    private const int FirstId = 0x5000;

    private readonly IntPtr _hwnd;
    private readonly HwndSource _source;
    private readonly Dictionary<int, Action> _actions = new();
    private int _nextId = FirstId;

    public GlobalHotkeys(Window window)
    {
        _hwnd = new WindowInteropHelper(window).EnsureHandle();
        _source = HwndSource.FromHwnd(_hwnd);
        _source.AddHook(Hook);
    }

    /// <summary>Registers a chord; returns its id, or null when it can't be read or another app owns it.</summary>
    public int? Register(string chord, Action action)
    {
        if (!TryParse(chord, out var modifiers, out var key))
        {
            return null;
        }
        var id = _nextId++;
        if (!RegisterHotKey(_hwnd, id, modifiers | MOD_NOREPEAT, key))
        {
            return null;
        }
        _actions[id] = action;
        return id;
    }

    public void Unregister(int? id)
    {
        if (id is { } registered && _actions.Remove(registered))
        {
            UnregisterHotKey(_hwnd, registered);
        }
    }

    /// <summary>
    /// Reads "Ctrl+Alt+J": modifiers (Ctrl, Alt, Shift, Win) and one key: a letter, a digit, F1–F24, Space or `
    /// (the key left of 1). At least one modifier is required, so a plain letter can't be taken from every app.
    /// </summary>
    public static bool TryParse(string chord, out uint modifiers, out uint key)
    {
        modifiers = 0;
        key = 0;
        foreach (var part in chord.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            switch (part.ToLowerInvariant())
            {
                case "ctrl" or "control": modifiers |= MOD_CONTROL; break;
                case "alt": modifiers |= MOD_ALT; break;
                case "shift": modifiers |= MOD_SHIFT; break;
                case "win": modifiers |= MOD_WIN; break;
                default:
                    if (key != 0)
                    {
                        return false;
                    }
                    key = KeyCode(part);
                    if (key == 0)
                    {
                        return false;
                    }
                    break;
            }
        }
        return key != 0 && modifiers != 0;
    }

    private static uint KeyCode(string name) => name.ToUpperInvariant() switch
    {
        [var c] when c is >= 'A' and <= 'Z' or >= '0' and <= '9' => c,
        "SPACE" => VK_SPACE,
        "`" => VK_OEM_3,
        ['F', .. var n] when int.TryParse(n, out var f) && f is >= 1 and <= LastFunctionKey => (uint)(VK_F1 + f - 1),
        _ => 0,
    };

    private IntPtr Hook(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == WM_HOTKEY && _actions.TryGetValue(wParam.ToInt32(), out var action))
        {
            handled = true;
            action();
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        foreach (var id in _actions.Keys)
        {
            UnregisterHotKey(_hwnd, id);
        }
        _actions.Clear();
        _source.RemoveHook(Hook);
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint key);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);
}
