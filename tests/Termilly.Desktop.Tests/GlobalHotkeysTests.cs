namespace Termilly.Desktop.Tests;

public sealed class GlobalHotkeysTests
{
    [Theory]
    [InlineData("Ctrl+Alt+J", 0x3u, (uint)'J')]
    [InlineData("ctrl + shift + `", 0x6u, 0xC0u)]
    [InlineData("Win+F12", 0x8u, 0x7Bu)]
    [InlineData("Alt+Space", 0x1u, 0x20u)]
    [InlineData("Ctrl+Alt+7", 0x3u, (uint)'7')]
    public void Chords_are_read(string chord, uint modifiers, uint key)
    {
        Assert.True(GlobalHotkeys.TryParse(chord, out var m, out var k));
        Assert.Equal((modifiers, key), (m, k));
    }

    [Theory]
    [InlineData("J")]              // no modifier: it would take the key from every app
    [InlineData("Ctrl+Alt")]       // no key
    [InlineData("Ctrl+J+K")]       // two keys
    [InlineData("Ctrl+F25")]
    [InlineData("Ctrl+Enter")]
    public void Anything_else_is_refused(string chord) => Assert.False(GlobalHotkeys.TryParse(chord, out _, out _));
}
