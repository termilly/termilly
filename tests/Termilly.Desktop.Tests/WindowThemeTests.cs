using Termilly.Desktop.Platform;
using Termilly.Desktop.Services;

namespace Termilly.Desktop.Tests;

/// <summary>The window's and loader's colours at start-up, before the page draws (WindowTheme).</summary>
public sealed class WindowThemeTests
{
    private sealed class Settings(AppSettings current) : ISettingsStore
    {
        public AppSettings Current { get; private set; } = current;
        public event Action<SettingsSaved>? Saved;
        public void Save(AppSettings settings) => Saved?.Invoke(new SettingsSaved(Current, Current = settings));
    }

    private sealed class SystemMode(bool prefersLight) : ISystemTheme
    {
        public bool PrefersLight { get; } = prefersLight;
    }

    /// <summary>A dark theme of the gallery's (Catppuccin Mocha) and a light one (Catppuccin Latte), as the page saves them.</summary>
    private static readonly ThemeWindowColors Mocha = new("#181825", "#313244", "#cdd6f4", "#cba6f7", false, "catppuccin-mocha");
    private static readonly ThemeWindowColors Latte = new("#e6e9ef", "#ccd0da", "#4c4f69", "#8839ef", true, "catppuccin-latte");
    private const string Following = SettingValues.Theme.System;

    private static ThemeWindowColors Palette(string theme, ThemeWindowColors? saved, bool systemLight,
        string darkPick = "catppuccin-mocha", string lightPick = "catppuccin-latte") =>
        new WindowTheme(new Settings(new AppSettings
        {
            Interface = new InterfaceSettings { Theme = theme, ThemeDark = darkPick, ThemeLight = lightPick },
            UiState = new UiState { WindowColors = saved },
        }), new SystemMode(systemLight)).Palette;

    [Fact]
    public void A_chosen_theme_starts_in_its_saved_colours() =>
        Assert.Same(Mocha, Palette("catppuccin-mocha", Mocha, systemLight: true));

    [Fact]
    public void Following_the_system_starts_in_the_saved_colours_while_they_are_the_picks_for_the_mode_now()
    {
        Assert.Same(Mocha, Palette(Following, Mocha, systemLight: false));
        Assert.Same(Latte, Palette(Following, Latte, systemLight: true));
    }

    [Fact]
    public void Following_the_system_starts_in_Light_or_Dark_once_the_mode_changed_since()
    {
        Assert.True(Palette(Following, Mocha, systemLight: true).Light);
        Assert.False(Palette(Following, Latte, systemLight: false).Light);
    }

    [Fact]
    public void Following_the_system_doesnt_take_another_dark_themes_colours_for_the_dark_pick() =>
        Assert.NotSame(Mocha, Palette(Following, Mocha, systemLight: false, darkPick: "kanagawa"));

    [Fact]
    public void Colours_saved_before_they_had_an_id_start_following_the_system_in_Dark_or_Light()
    {
        var legacy = Mocha with { Id = null };
        Assert.NotSame(legacy, Palette(Following, legacy, systemLight: false));
    }

    [Fact]
    public void Nothing_saved_yet_starts_in_Dark_or_Light()
    {
        Assert.False(Palette(SettingValues.Theme.Dark, null, systemLight: true).Light);
        Assert.True(Palette(Following, null, systemLight: true).Light);
    }

    [Fact]
    public void The_picks_for_following_the_system_start_as_Dark_and_Light_and_an_unknown_one_goes_back()
    {
        var picks = new InterfaceSettings().Normalize();
        Assert.Equal(SettingValues.Theme.Dark, picks.ThemeDark);
        Assert.Equal(SettingValues.Theme.Light, picks.ThemeLight);
        var bad = new InterfaceSettings { ThemeDark = "../evil", ThemeLight = Following }.Normalize();
        Assert.Equal(SettingValues.Theme.Dark, bad.ThemeDark);
        Assert.Equal(SettingValues.Theme.Light, bad.ThemeLight);
    }
}
