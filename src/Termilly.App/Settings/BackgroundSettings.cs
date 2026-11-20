using Termilly.Desktop.Features;

namespace Termilly.Desktop;

/// <summary>
/// The values the background settings take (Settings › Appearance › Background, js/settings/appearancebackground.js),
/// as saved and as the page offers them. <c>All</c> is what <see cref="BackgroundSettings.Normalize"/> accepts.
/// </summary>
internal static class BackgroundValues
{
    /// <summary>What the desktop looks like through the window where it's see-through.</summary>
    public static class Effect
    {
        public const string None = "none";
        public const string Blur = "blur";
        /// <summary>Blur with a little grain and tint (Windows 10 and 11).</summary>
        public const string Acrylic = "acrylic";
        /// <summary>Only the wallpaper's colour (Windows 11).</summary>
        public const string Mica = "mica";
        public const string Default = None;
        public static readonly IReadOnlyList<string> All = [None, Blur, Acrylic, Mica];
    }

    /// <summary>How much of the window's own colour stays, in percent: 100 is solid, as before.</summary>
    public static class Opacity
    {
        public const int Min = 40;
        public const int Max = 100;
        public const int Default = Max;
    }

    /// <summary>How a picture fills the space behind: covering it, all of it shown, at its own size, or repeated.</summary>
    public static class Fit
    {
        public const string Fill = "fill";
        public const string Contain = "fit";
        public const string Center = "center";
        public const string Tile = "tile";
        public const string Default = Fill;
        public static readonly IReadOnlyList<string> All = [Fill, Contain, Center, Tile];
    }

    /// <summary>How much the picture is darkened (or lightened, in a light theme) so text reads on it, in percent.</summary>
    public static class Dim
    {
        public const int Min = 0;
        public const int Max = 90;
        public const int Default = 50;
    }

    /// <summary>How much the picture is blurred, in pixels.</summary>
    public static class Blur
    {
        public const int Min = 0;
        public const int Max = 20;
        public const int Default = 0;
    }

    /// <summary>Where the picture shows: behind the terminals only, or behind the whole window.</summary>
    public static class Behind
    {
        public const string Terminals = "terminals";
        public const string Window = "window";
        public const string Default = Terminals;
        public static readonly IReadOnlyList<string> All = [Terminals, Window];
    }

    /// <summary>A workspace's own background (its right-click menu): the window's, none, a gradient or a picture.</summary>
    public static class WorkspaceKind
    {
        /// <summary>As Settings › Appearance › Background has it.</summary>
        public const string Window = "window";
        public const string None = "none";
        public const string Gradient = "gradient";
        public const string Picture = "picture";
        public const string Default = Window;
        public static readonly IReadOnlyList<string> All = [Window, None, Gradient, Picture];
    }

    /// <summary>The gradients a workspace can have (js/backgrounds.js draws them).</summary>
    public static class Gradient
    {
        public const string Aurora = "aurora";
        public const string Ember = "ember";
        public const string Dusk = "dusk";
        public const string Ocean = "ocean";
        public const string Moss = "moss";
        public const string Slate = "slate";
        public static readonly IReadOnlyList<string> All = [Aurora, Ember, Dusk, Ocean, Moss, Slate];
    }
}

/// <summary>
/// The window's background (Settings › Appearance › Background): how see-through it is and what shows through, and a
/// picture behind the terminals or the whole window. The defaults are a solid window with no picture, as before.
/// </summary>
internal sealed record BackgroundSettings
{
    /// <summary>The window's own colour in percent (<see cref="BackgroundValues.Opacity"/>); below 100 the desktop shows through.</summary>
    public int Opacity { get; init; } = BackgroundValues.Opacity.Default;
    /// <summary>What shows through (<see cref="BackgroundValues.Effect"/>), where the system has it.</summary>
    public string Effect { get; init; } = BackgroundValues.Effect.Default;
    /// <summary>The window turns solid while another app is in front.</summary>
    public bool SolidWhenInactive { get; init; } = true;
    /// <summary>Only the window around the terminals is see-through; the terminals keep their colour.</summary>
    public bool SolidTerminals { get; init; }
    /// <summary>The picture's file in the backgrounds folder (<see cref="BackgroundPictures"/>), or none.</summary>
    public string? Picture { get; init; }
    public string Fit { get; init; } = BackgroundValues.Fit.Default;
    public int Dim { get; init; } = BackgroundValues.Dim.Default;
    public int Blur { get; init; } = BackgroundValues.Blur.Default;
    public string Behind { get; init; } = BackgroundValues.Behind.Default;

    /// <summary>The desktop shows through: the host makes the window see-through, with the effect asked for.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool SeeThrough => Opacity < BackgroundValues.Opacity.Max;

    public BackgroundSettings Normalize() => this with
    {
        Opacity = Math.Clamp(Opacity, BackgroundValues.Opacity.Min, BackgroundValues.Opacity.Max),
        Effect = SettingChecks.OneOf(Effect, BackgroundValues.Effect.All, BackgroundValues.Effect.Default),
        Picture = BackgroundPictures.IsName(Picture) ? Picture : null,
        Fit = SettingChecks.OneOf(Fit, BackgroundValues.Fit.All, BackgroundValues.Fit.Default),
        Dim = Math.Clamp(Dim, BackgroundValues.Dim.Min, BackgroundValues.Dim.Max),
        Blur = Math.Clamp(Blur, BackgroundValues.Blur.Min, BackgroundValues.Blur.Max),
        Behind = SettingChecks.OneOf(Behind, BackgroundValues.Behind.All, BackgroundValues.Behind.Default),
    };
}
