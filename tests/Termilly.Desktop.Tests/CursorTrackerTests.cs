using Termilly.Desktop.Features;

namespace Termilly.Desktop.Tests;

/// <summary>Where a terminal's cursor is, followed from what its shell prints before the page is up.</summary>
public sealed class CursorTrackerTests
{
    private static string After(params string[] chunks)
    {
        var cursor = new CursorTracker(10, 5);
        foreach (var chunk in chunks)
        {
            cursor.Follow(chunk);
        }
        return cursor.Report;
    }

    [Theory]
    [InlineData("", "\u001b[1;1R")]
    [InlineData("abc", "\u001b[1;4R")]
    [InlineData("abc\r\nde", "\u001b[2;3R")]
    [InlineData("abc\rX", "\u001b[1;2R")]
    // Text wraps at the width: a full line waits in its last column, the 11th character starts the next line.
    [InlineData("0123456789", "\u001b[1;10R")]
    [InlineData("0123456789a", "\u001b[2;2R")]
    // It stays on the screen: the bottom line scrolls.
    [InlineData("\n\n\n\n\n\n\nx", "\u001b[5;2R")]
    // Moves: to a place, up, down, right, left, a column, a row.
    [InlineData("\u001b[3;4H", "\u001b[3;4R")]
    [InlineData("\u001b[H", "\u001b[1;1R")]
    [InlineData("\u001b[4;4H\u001b[2A\u001b[B\u001b[3C\u001b[D", "\u001b[3;6R")]
    [InlineData("abcdef\u001b[2G", "\u001b[1;2R")]
    [InlineData("\u001b[4d", "\u001b[4;1R")]
    // Wide characters take two columns, combining marks none; one that doesn't fit wraps whole.
    [InlineData("a界", "\u001b[1;4R")]
    [InlineData("éx", "\u001b[1;3R")]
    [InlineData("😀", "\u001b[1;3R")]
    [InlineData("012345678界", "\u001b[2;3R")]
    // Tabs stop every 8 columns, the last one at the edge.
    [InlineData("a\t", "\u001b[1;9R")]
    [InlineData("a\t\t\t", "\u001b[1;10R")]
    // A line break after a full line doesn't wrap it as well.
    [InlineData("0123456789\nX", "\u001b[2;10R")]
    // Saved and restored: ESC 7 and 8, CSI s and u, the alternate screen.
    [InlineData("ab\u001b7\u001b[4;1Hxyz\u001b8", "\u001b[1;3R")]
    [InlineData("ab\u001b[s\u001b[4;1H\u001b[u", "\u001b[1;3R")]
    [InlineData("abc\u001b[?1049h\u001b[5;1Hfull screen\u001b[?1049l", "\u001b[1;4R")]
    // A scroll region set puts the cursor home.
    [InlineData("\u001b[3;3H\u001b[2;4r", "\u001b[1;1R")]
    // What draws nothing: colours, modes, titles, marks.
    [InlineData("\u001b[1;31mab\u001b[0m\u001b[?2004h\u001b]0;title\u0007\u001b]133;A\u001b\\", "\u001b[1;3R")]
    public void The_cursor_is_where_the_output_left_it(string output, string report)
    {
        Assert.Equal(report, After(output));
    }

    [Fact]
    public void A_sequence_split_between_chunks_is_followed_whole()
    {
        Assert.Equal("\u001b[3;4R", After("ab\u001b[3", ";4H"));
        Assert.Equal("\u001b[1;3R", After("ab\u001b]0;ti", "tle\u0007"));
    }
}
