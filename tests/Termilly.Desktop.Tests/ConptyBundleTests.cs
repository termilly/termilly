using System.IO;

namespace Termilly.Desktop.Tests;

public sealed class ConptyBundleTests
{
    // Without these the app quietly falls back to Windows 10's console host, whose VT bugs this bundle fixes
    // (e.g. Claude Code's input line drifting a column because SI was counted as a printed cell).
    [Theory]
    [InlineData("conpty.dll")]
    [InlineData("x64", "OpenConsole.exe")]
    public void The_bundled_conpty_is_copied_next_to_the_app(params string[] path) =>
        Assert.True(File.Exists(Path.Combine([AppContext.BaseDirectory, "conpty", .. path])), Path.Combine(path));
}
