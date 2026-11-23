using Termilly.Desktop;

namespace Termilly.Core.Tests;

/// <summary>The LANG a macOS terminal starts with when Termilly was opened without a locale (MacLocale.cs).</summary>
public sealed class MacLocaleTests
{
    private static Func<string, string?> Env(params (string Name, string Value)[] vars) =>
        name => vars.FirstOrDefault(v => v.Name == name).Value;

    private static readonly HashSet<string> MacLocales = ["en_US.UTF-8", "zh_CN.UTF-8", "zh_TW.UTF-8", "de_DE.UTF-8"];
    private static bool OnThisMac(string name) => MacLocales.Contains(name);

    [Theory]
    [InlineData("zh_CN", "zh_CN.UTF-8")]
    [InlineData("zh-Hans_CN", "zh_CN.UTF-8")]
    [InlineData("zh-Hant_TW", "zh_TW.UTF-8")]
    [InlineData("de_DE@rg=atzzzz", "de_DE.UTF-8")]
    [InlineData("sr_RS", "en_US.UTF-8")]
    [InlineData("", "en_US.UTF-8")]
    [InlineData(null, "en_US.UTF-8")]
    public void With_no_locale_the_users_own_is_set_in_its_UTF8_form_or_en_US(string? system, string lang) =>
        Assert.Equal(lang, MacLocale.LangFor(Env(), system, OnThisMac));

    [Theory]
    [InlineData("LANG", "en_GB.UTF-8")]
    [InlineData("LANG", "C")]
    [InlineData("LC_CTYPE", "UTF-8")]
    [InlineData("LC_ALL", "ja_JP.UTF-8")]
    public void A_locale_the_user_set_is_left_alone(string name, string value) =>
        Assert.Null(MacLocale.LangFor(Env((name, value)), "zh_CN", OnThisMac));

    [Fact]
    public void An_empty_variable_counts_as_none() =>
        Assert.Equal("zh_CN.UTF-8", MacLocale.LangFor(Env(("LANG", ""), ("LC_ALL", "")), "zh_CN", OnThisMac));

    [Fact]
    public void On_a_Mac_the_system_locale_is_read()
    {
        if (!OperatingSystem.IsMacOS())
        {
            return;
        }
        // Whatever the Mac's language, the result is a UTF-8 locale, or nothing when the test run has one set.
        var lang = MacLocale.Lang;
        Assert.True(lang is null || lang.EndsWith(".UTF-8", StringComparison.Ordinal), lang);
    }
}
