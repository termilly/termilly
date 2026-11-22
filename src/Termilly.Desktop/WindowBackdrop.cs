using System.IO;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Termilly.Desktop.Features;

namespace Termilly.Desktop;

/// <summary>
/// The window's background on Windows (Settings › Appearance › Background): see-through, so the desktop shows where the
/// page lets it, with the system's blur or acrylic behind; or solid, as before. Also where the page's browsers
/// load background pictures from.
/// </summary>
internal static class WindowBackdrop
{
    /// <summary>The address the backgrounds folder is served under, in the main window's browser and the detached ones'.</summary>
    private const string PictureHost = "backgrounds.termilly.local";

    public static string PictureBase => $"https://{PictureHost}/";

    /// <summary>Windows 11's first build, and the one with the documented backdrop types (acrylic).</summary>
    private const int Windows11 = 22000;
    private const int Windows11Backdrops = 22621;

    private static readonly int Build = Environment.OSVersion.Version.Build;

    /// <summary>
    /// The effects this Windows draws (each seen on screen; see-through with nothing behind shows white on 10 and on 11
    /// 22H2 and later, so neither has None):
    /// 11 22H2 and later: its own acrylic only; the older blur (an accent) shows white there, and once set it stops the
    /// system's acrylic too, so it is never used. Its Mica isn't offered: it shows only the wallpaper's colour, never
    /// what's behind, so it looked like no effect at all.
    /// 11 before 22H2: as first built, without Mica (not seen on screen).
    /// 10: blur only (an accent); its acrylic accent draws a flat grey with nothing of what's behind (seen with a red and
    /// blue window behind, where blur showed both), so it isn't offered and a saved Acrylic shows as Blur.
    /// </summary>
    public static IReadOnlyList<string> Effects { get; } = Build >= Windows11Backdrops
        ? [BackgroundValues.Effect.Acrylic]
        : Build >= Windows11
            ? [BackgroundValues.Effect.None, BackgroundValues.Effect.Blur, BackgroundValues.Effect.Acrylic]
            : [BackgroundValues.Effect.Blur];

    /// <summary>
    /// A browser can show the background pictures (no other site's page can fetch them as data), nothing else of the
    /// data folder. Without the folder (it can't be made), there are no pictures, and nothing else changes.
    /// </summary>
    public static void MapPictures(CoreWebView2 core)
    {
        try
        {
            Directory.CreateDirectory(BackgroundPictures.Folder);
        }
        catch (Exception e) when (Services.Storage.IsFileError(e))
        {
            return;
        }
        core.SetVirtualHostNameToFolderMapping(PictureHost, BackgroundPictures.Folder, CoreWebView2HostResourceAccessKind.DenyCors);
    }

    /// <summary>The glass WindowChrome keeps while solid: a one-pixel edge, for the system's shadow (MainWindow.xaml).</summary>
    private static readonly Thickness SolidGlass = new(0, 0, 0, 1);
    /// <summary>The whole window is glass: where the page draws nothing, the desktop shows.</summary>
    private static readonly Thickness SeeThroughGlass = new(-1);

    /// <summary>
    /// Makes a window see-through with the effect asked for (one this Windows has, else none), or solid again. Call after
    /// the window's colours are set (they're taken off while see-through) and once it has a handle.
    /// </summary>
    /// <param name="dark">The theme is dark: acrylic takes a dark tint.</param>
    /// <param name="tint">The theme's background (#RRGGBB): the acrylic accent's tint (Windows 11 before 22H2).</param>
    public static void Apply(Window window, WebView2 web, BackgroundSettings background, bool dark, string tint)
    {
        var hwnd = new WindowInteropHelper(window).Handle;
        if (hwnd == IntPtr.Zero)
        {
            return;
        }
        Prepare(window, hwnd, tint);
        var seeThrough = background.SeeThrough;
        // A window never made see-through is otherwise left as it is (the default): nothing to undo.
        if (!seeThrough && !SolidAgain.ContainsKey(hwnd))
        {
            return;
        }
        var target = HwndSource.FromHwnd(hwnd)?.CompositionTarget;
        if (seeThrough && !SolidAgain.ContainsKey(hwnd))
        {
            SolidAgain[hwnd] = target?.BackgroundColor ?? Colors.Black;
            window.Closed += (_, _) => SolidAgain.Remove(hwnd);
        }
        if (WindowChrome.GetWindowChrome(window) is { } chrome)
        {
            chrome.GlassFrameThickness = seeThrough ? SeeThroughGlass : SolidGlass;
        }
        if (target is not null)
        {
            target.BackgroundColor = seeThrough ? Colors.Transparent : SolidAgain[hwnd];
        }
        if (seeThrough)
        {
            window.Background = Brushes.Transparent;
            web.DefaultBackgroundColor = System.Drawing.Color.Transparent;
        }
        var effect = !seeThrough ? BackgroundValues.Effect.None : Effects.Contains(background.Effect) ? background.Effect : Effects[0];
        // Windows 11's acrylic takes a dark tint from it; Windows 10 has no use for it. Solid again:
        // off, as a window that never was see-through.
        if (Build >= Windows11)
        {
            Dwm.SetDark(hwnd, seeThrough && dark);
        }
        Dwm.SetEffect(hwnd, seeThrough, effect, tint);
        if (!seeThrough)
        {
            SolidAgain.Remove(hwnd);
        }
    }

    /// <summary>
    /// Windows 10 takes a blur only on a window that had an effect before it was first shown: every window gets a plain
    /// one then, in the theme's background (it shows only before the window is first drawn), so a blur can be turned on
    /// later. Not on 11, where it would stop acrylic.
    /// </summary>
    private static void Prepare(Window window, IntPtr hwnd, string background)
    {
        if (Build < Windows11 && Prepared.Add(hwnd))
        {
            Dwm.Prepare(hwnd, background);
            window.Closed += (_, _) => Prepared.Remove(hwnd);
        }
    }

    /// <summary>The windows made see-through, with the colour WPF cleared them to before (theirs again when solid).</summary>
    private static readonly Dictionary<IntPtr, Color> SolidAgain = [];

    /// <summary>The windows given their clear effect (Dwm.Prepare).</summary>
    private static readonly HashSet<IntPtr> Prepared = [];

    /// <summary>The compositor's calls: what shows through a see-through window.</summary>
    private static class Dwm
    {
        private const int DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
        private const int DWMWA_SYSTEMBACKDROP_TYPE = 38;
        private const int DWMSBT_AUTO = 0;
        private const int DWMSBT_TRANSIENTWINDOW = 3;

        private const int WCA_ACCENT_POLICY = 19;
        private const int ACCENT_DISABLED = 0;
        /// <summary>A plain colour behind the window: "no effect" that still lets a blur come later.</summary>
        private const int ACCENT_ENABLE_TRANSPARENTGRADIENT = 2;
        private const int ACCENT_ENABLE_BLURBEHIND = 3;
        private const int ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
        /// <summary>The acrylic accent's own tint (Windows 11 before 22H2): the theme's colour, faint (0 to 255), as the page already shades the window by Opacity.</summary>
        private const byte AcrylicTintAlpha = 0x20;
        private const byte Opaque = 0xFF;
        /// <summary>The effect takes GradientColor; without it, Windows fills it with the system's accent colour.</summary>
        private const int AccentDrawAllBorders = 2;
        /// <summary>Where each channel sits in AABBGGRR.</summary>
        private const int AlphaShift = 24;
        private const int BlueShift = 16;
        private const int GreenShift = 8;

        private const int DWM_BB_ENABLE = 0x1;
        private const int DWM_BB_BLURREGION = 0x2;

        public static void SetDark(IntPtr hwnd, bool dark)
        {
            var value = dark ? 1 : 0;
            _ = DwmSetWindowAttribute(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, ref value, sizeof(int));
        }

        /// <summary>
        /// The plain effect every window starts with on Windows 10 (Prepare says why), in the theme's background: with the
        /// system's accent colour instead, that colour flashed before the start-up screen.
        /// </summary>
        public static void Prepare(IntPtr hwnd, string background) =>
            SetAccent(hwnd, ACCENT_ENABLE_TRANSPARENTGRADIENT, ColourOf(background, Opaque), AccentDrawAllBorders);

        public static void SetEffect(IntPtr hwnd, bool seeThrough, string effect, string tint)
        {
            if (Build >= Windows11Backdrops)
            {
                SetSystemBackdrop(hwnd, seeThrough);
                return;
            }
            // Windows 10: back to the plain effect first, so switching leaves nothing of the old one; never off, or it
            // wouldn't take a blur again. 11 before 22H2: off first, as first built.
            if (Build < Windows11)
            {
                Prepare(hwnd, tint);
            }
            else
            {
                SetAccent(hwnd, ACCENT_DISABLED, 0, 0);
            }
            ClearBlurBehind(hwnd, seeThrough);
            if (!seeThrough)
            {
                return;
            }
            switch (effect)
            {
                case BackgroundValues.Effect.Blur:
                    SetAccent(hwnd, ACCENT_ENABLE_BLURBEHIND, 0, AccentDrawAllBorders);
                    break;
                case BackgroundValues.Effect.Acrylic:
                    SetAccent(hwnd, ACCENT_ENABLE_ACRYLICBLURBEHIND, ColourOf(tint, AcrylicTintAlpha), AccentDrawAllBorders);
                    break;
            }
        }

        /// <summary>Windows 11 22H2 and later: the system's own acrylic, or the default again when solid.</summary>
        private static void SetSystemBackdrop(IntPtr hwnd, bool seeThrough) => SetBackdrop(hwnd, seeThrough ? DWMSBT_TRANSIENTWINDOW : DWMSBT_AUTO);

        private static void SetBackdrop(IntPtr hwnd, int type) => _ = DwmSetWindowAttribute(hwnd, DWMWA_SYSTEMBACKDROP_TYPE, ref type, sizeof(int));

        /// <summary>
        /// See-through with nothing behind: blur-behind on a region outside the window, which makes Windows honour the
        /// page's see-through pixels without blurring anything. Off when solid.
        /// </summary>
        private static void ClearBlurBehind(IntPtr hwnd, bool on)
        {
            var region = on ? CreateRectRgn(0, 0, -1, -1) : IntPtr.Zero;
            var blur = new DWM_BLURBEHIND { dwFlags = DWM_BB_ENABLE | DWM_BB_BLURREGION, fEnable = on, hRgnBlur = region };
            _ = DwmEnableBlurBehindWindow(hwnd, ref blur);
            if (region != IntPtr.Zero)
            {
                _ = DeleteObject(region);
            }
        }

        /// <summary>#RRGGBB as the accent policy's colour: AABBGGRR.</summary>
        private static uint ColourOf(string hex, byte alpha)
        {
            var c = System.Drawing.ColorTranslator.FromHtml(hex);
            return ((uint)alpha << AlphaShift) | ((uint)c.B << BlueShift) | ((uint)c.G << GreenShift) | c.R;
        }

        /// <param name="flags">Which window edges the effect draws on: none for the clear one, which changes nothing.</param>
        private static void SetAccent(IntPtr hwnd, int state, uint colour, int flags)
        {
            var accent = new ACCENT_POLICY { AccentState = state, AccentFlags = flags, GradientColor = colour };
            var size = Marshal.SizeOf<ACCENT_POLICY>();
            var pointer = Marshal.AllocHGlobal(size);
            try
            {
                Marshal.StructureToPtr(accent, pointer, false);
                var data = new WINDOWCOMPOSITIONATTRIBDATA { Attribute = WCA_ACCENT_POLICY, Data = pointer, SizeOfData = size };
                _ = SetWindowCompositionAttribute(hwnd, ref data);
            }
            finally
            {
                Marshal.FreeHGlobal(pointer);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct ACCENT_POLICY
        {
            public int AccentState;
            public int AccentFlags;
            public uint GradientColor;
            public int AnimationId;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct WINDOWCOMPOSITIONATTRIBDATA
        {
            public int Attribute;
            public IntPtr Data;
            public int SizeOfData;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct DWM_BLURBEHIND
        {
            public int dwFlags;
            [MarshalAs(UnmanagedType.Bool)] public bool fEnable;
            public IntPtr hRgnBlur;
            [MarshalAs(UnmanagedType.Bool)] public bool fTransitionOnMaximized;
        }

        [DllImport("dwmapi.dll")]
        private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);

        [DllImport("dwmapi.dll")]
        private static extern int DwmEnableBlurBehindWindow(IntPtr hwnd, ref DWM_BLURBEHIND blurBehind);

        [DllImport("user32.dll")]
        private static extern int SetWindowCompositionAttribute(IntPtr hwnd, ref WINDOWCOMPOSITIONATTRIBDATA data);

        [DllImport("gdi32.dll")]
        private static extern IntPtr CreateRectRgn(int left, int top, int right, int bottom);

        [DllImport("gdi32.dll")]
        private static extern bool DeleteObject(IntPtr handle);
    }
}
