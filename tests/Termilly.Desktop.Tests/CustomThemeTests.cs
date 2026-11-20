namespace Termilly.Desktop.Tests;

/// <summary>Colour schemes imported from other terminals, as settings keep them (CustomTheme, InterfaceSettings).</summary>
public sealed class CustomThemeTests
{
    private static readonly string[] Dracula =
    [
        "#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2",
        "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff",
    ];

    private static CustomTheme Theme(string id = "custom-dracula", string name = "Dracula", string background = "#282a36",
        string? cursor = "#f8f8f2", IReadOnlyList<string>? ansi = null) =>
        new(id, name, background, "#f8f8f2", cursor, ansi ?? Dracula);

    [Fact]
    public void A_whole_scheme_is_kept_with_its_name_trimmed() =>
        Assert.Equal("Dracula", Theme(name: "  Dracula  ").Normalize()?.Name);

    [Fact]
    public void A_long_name_is_cut() =>
        Assert.Equal(CustomThemeLimits.MaxName, Theme(name: new string('x', 200)).Normalize()?.Name.Length);

    [Theory]
    [InlineData("dracula")] // not an imported theme's id: it could take a built-in one's
    [InlineData("midnight")]
    public void An_id_without_the_imported_prefix_is_refused(string id) => Assert.Null(Theme(id: id).Normalize());

    [Fact]
    public void A_bad_colour_or_a_missing_one_is_refused()
    {
        Assert.Null(Theme(background: "red").Normalize());
        Assert.Null(Theme(cursor: "#12").Normalize());
        Assert.Null(Theme(ansi: Dracula[..15]).Normalize());
        Assert.Null(Theme(ansi: [.. Dracula[..15], "url(x)"]).Normalize());
        Assert.Null(Theme(name: "  ").Normalize());
    }

    [Fact]
    public void No_cursor_colour_is_fine() => Assert.NotNull(Theme(cursor: null).Normalize());

    [Fact]
    public void Settings_keep_the_good_ones_once_each_and_at_most_fifty()
    {
        var many = Enumerable.Range(0, 70).Select(i => Theme(id: $"custom-{i}")).ToList();
        var kept = new InterfaceSettings { CustomThemes = [Theme(), Theme(), Theme(id: "bad"), .. many] }.Normalize().CustomThemes!;
        Assert.Equal(50, kept.Count);
        Assert.Single(kept, t => t.Id == "custom-dracula");
        Assert.DoesNotContain(kept, t => t.Id == "bad");
    }

    [Fact]
    public void No_imported_themes_is_an_empty_list() =>
        Assert.Empty(new InterfaceSettings().Normalize().CustomThemes!);
}
