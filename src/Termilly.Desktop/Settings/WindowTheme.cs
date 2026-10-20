using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop;

/// <summary>
/// The colours of the window and the start-up loader before the page draws: the chosen theme's, which the page saves
/// (js/themes.js), or Dark's or Light's for "system" (the system's own mode) and before it has. They match --bg, the
/// frame, --text and --accent in app.css.
/// </summary>
internal sealed class WindowTheme(ISettingsStore settings, ISystemTheme system)
{
    /// <summary>Light's and Dark's window colours, for "system" and before the page has saved a theme's.</summary>
    private static readonly ThemeWindowColors LightPalette = new("#F3F3F5", "#D4D4DA", "#1D1D22", "#6D5CF0", true);
    private static readonly ThemeWindowColors DarkPalette = new("#000000", "#262626", "#E6E6E6", "#8B7BFF", false);

    public ThemeWindowColors Palette
    {
        get
        {
            var current = settings.Current;
            var chosen = current.UiState.WindowColors;
            return current.Interface.Theme != SettingValues.Theme.System && chosen is not null ? chosen
                : IsLight(current.Interface.Theme, chosen) ? LightPalette
                : DarkPalette;
        }
    }

    /// <summary>Whether the window should be light: the setting, or the system's mode for "system".</summary>
    private bool IsLight(string theme, ThemeWindowColors? chosen) => theme switch
    {
        SettingValues.Theme.Light => true,
        SettingValues.Theme.System => system.PrefersLight,
        SettingValues.Theme.Dark => false,
        _ => chosen?.Light ?? false,
    };
}
