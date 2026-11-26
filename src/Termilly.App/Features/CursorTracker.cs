using System.Globalization;
using System.Text;

namespace Termilly.Desktop.Features;

/// <summary>
/// Where a terminal's cursor is, followed from what its shell prints before the page draws it (EarlyShell), as
/// xterm.js would place it: text (wide characters two columns, combining marks none) and its wrapping at the terminal's
/// width, line breaks, carriage returns, backspaces and tabs, the cursor moves shells and their prompts use (CSI H, f,
/// A, B, C, D, G, d), its save and restore (ESC 7 and 8, CSI s and u, the alternate screen), and a scroll region homing
/// it. Other sequences move nothing. Enough to answer "where's the cursor" (CSI 6 n) as a shell starts, which
/// PowerShell asks at each prompt and waits for.
/// </summary>
internal sealed class CursorTracker(int columns, int rows)
{
    private const char Escape = '\u001b';
    private const char Bell = '\u0007';
    /// <summary>Where tabs stop: every 8 columns, as a terminal's start.</summary>
    private const int TabWidth = 8;
    /// <summary>The alternate screen's mode (CSI ? 1049 h and l), which saves and restores the cursor.</summary>
    private const string AlternateScreen = "?1049";

    private int _row = 1;
    /// <summary>The column the next character goes in; one past the last when a full line waits to wrap.</summary>
    private int _column = 1;
    /// <summary>Where ESC 7 (or CSI s) saved the cursor: one place for each screen, as xterm.js keeps them.</summary>
    private (int Row, int Column) _savedNormal = (1, 1);
    private (int Row, int Column) _savedAlternate = (1, 1);
    private bool _alternate;
    /// <summary>The scroll region's last row: a line break there scrolls it rather than moving down.</summary>
    private int _bottom; // 0: none set, the screen's bottom
    /// <summary>A sequence split between two chunks of output: its start, finished by the next.</summary>
    private string _pending = "";

    /// <summary>Its place, as the answer to CSI 6 n gives it: CSI row ; column R (a full line waits in its last column).</summary>
    public string Report => $"{Escape}[{_row};{Math.Min(_column, columns)}R";

    /// <summary>Follows the cursor through output.</summary>
    public void Follow(string output)
    {
        var text = _pending + output;
        _pending = "";
        var i = 0;
        while (i < text.Length)
        {
            if (text[i] == Escape)
            {
                var length = SequenceLength(text, i);
                if (length == 0)
                {
                    _pending = text[i..]; // not finished yet: the next chunk has the rest
                    return;
                }
                Sequence(text.Substring(i, length));
                i += length;
                continue;
            }
            // A broken surrogate pair counts as one character, as the page shows it.
            if (Rune.DecodeFromUtf16(text.AsSpan(i), out var rune, out var used) != System.Buffers.OperationStatus.Done)
            {
                (rune, used) = (Rune.ReplacementChar, 1);
            }
            Character(rune);
            i += used;
        }
    }

    private void Character(Rune rune)
    {
        switch (rune.Value)
        {
            case '\r':
                _column = 1;
                break;
            case '\n':
                _column = Math.Min(_column, columns); // a line break ends a wrap that was waiting
                Down(1);
                break;
            case '\b':
                _column = Math.Max(1, Math.Min(_column, columns) - 1);
                break;
            case '\t':
                _column = Math.Min(columns, ((Math.Min(_column, columns) - 1) / TabWidth + 1) * TabWidth + 1);
                break;
            default:
                Printed(Width(rune));
                break;
        }
    }

    /// <summary>A character of the width given: wrapping first when it doesn't fit what's left of the line.</summary>
    private void Printed(int width)
    {
        if (width == 0)
        {
            return;
        }
        if (_column + width - 1 > columns)
        {
            _column = 1;
            Down(1);
        }
        _column += width;
    }

    /// <summary>Columns a character takes: none for controls and combining marks, two for wide ones.</summary>
    private static int Width(Rune rune)
    {
        if (Rune.IsControl(rune))
        {
            return 0;
        }
        var category = Rune.GetUnicodeCategory(rune);
        if (category is UnicodeCategory.NonSpacingMark or UnicodeCategory.EnclosingMark or UnicodeCategory.Format)
        {
            return 0;
        }
        return Wide(rune.Value) ? 2 : 1;
    }

    /// <summary>East Asian wide and full-width characters, and emoji: two columns.</summary>
    private static bool Wide(int c) =>
        c is (>= 0x1100 and <= 0x115F) or (>= 0x2E80 and <= 0x303E) or (>= 0x3041 and <= 0x33FF) or (>= 0x3400 and <= 0x4DBF)
            or (>= 0x4E00 and <= 0x9FFF) or (>= 0xA000 and <= 0xA4CF) or (>= 0xAC00 and <= 0xD7A3) or (>= 0xF900 and <= 0xFAFF)
            or (>= 0xFE30 and <= 0xFE4F) or (>= 0xFF00 and <= 0xFF60) or (>= 0xFFE0 and <= 0xFFE6) or (>= 0x1F300 and <= 0x1F64F)
            or (>= 0x1F680 and <= 0x1F6FF) or (>= 0x1FA70 and <= 0x1FAFF)
            or (>= 0x1F900 and <= 0x1F9FF) or (>= 0x20000 and <= 0x3FFFD);

    /// <summary>Down, stopping at the scroll region's bottom when within it (the region scrolls instead).</summary>
    private void Down(int lines) => _row = Math.Min(_bottom > 0 && _row <= _bottom ? _bottom : rows, _row + lines);

    /// <summary>The length of the escape sequence at <paramref name="at"/>, 0 when it isn't finished.</summary>
    private static int SequenceLength(string text, int at)
    {
        if (at + 1 >= text.Length)
        {
            return 0;
        }
        var kind = text[at + 1];
        if (kind == '[')
        {
            for (var i = at + 2; i < text.Length; i++)
            {
                if (text[i] is >= '@' and <= '~')
                {
                    return i - at + 1;
                }
            }
            return 0;
        }
        if (kind is ']' or 'P' or '_' or '^')
        {
            for (var i = at + 2; i < text.Length; i++)
            {
                if (text[i] == Bell)
                {
                    return i - at + 1;
                }
                if (text[i] == Escape && i + 1 < text.Length && text[i + 1] == '\\')
                {
                    return i - at + 2;
                }
            }
            return 0;
        }
        return 2; // ESC and one character
    }

    /// <summary>An escape sequence: a save or restore of the cursor (ESC 7, 8), or a CSI one.</summary>
    private void Sequence(string sequence)
    {
        switch (sequence)
        {
            case "\u001b7":
                Save();
                return;
            case "\u001b8":
                Restore();
                return;
        }
        if (sequence.Length >= 3 && sequence[1] == '[')
        {
            Control(sequence[2..^1], sequence[^1]);
        }
    }

    private void Save()
    {
        var place = (_row, Math.Min(_column, columns));
        if (_alternate)
        {
            _savedAlternate = place;
        }
        else
        {
            _savedNormal = place;
        }
    }

    private void Restore() => (_row, _column) = _alternate ? _savedAlternate : _savedNormal;

    /// <summary>A CSI sequence: its parameters and final character.</summary>
    private void Control(string parameters, char final)
    {
        if (parameters == AlternateScreen)
        {
            if (final == 'h')
            {
                Save(); // the normal screen's place, restored as it leaves
                _alternate = true;
            }
            else if (final == 'l')
            {
                _alternate = false;
                Restore();
            }
            return;
        }
        if (parameters.Length > 0 && !char.IsDigit(parameters[0]) && parameters[0] != ';')
        {
            return; // private (CSI ? …): modes, not moves
        }
        var numbers = parameters.Split(';').Select(p => int.TryParse(p, out var n) ? n : 0).ToArray();
        if (final == 'r')
        {
            Region(numbers);
            return;
        }
        Move(final, index => index < numbers.Length && numbers[index] > 0 ? numbers[index] : 1);
    }

    private void Move(char final, Func<int, int> at)
    {
        switch (final)
        {
            case 'H' or 'f':
                (_row, _column) = (Math.Clamp(at(0), 1, rows), Math.Clamp(at(1), 1, columns));
                break;
            case 'A':
                _row = Math.Max(1, _row - at(0));
                break;
            case 'B':
                Down(at(0));
                break;
            case 'C':
                _column = Math.Min(columns, Math.Min(_column, columns) + at(0));
                break;
            case 'D':
                _column = Math.Max(1, Math.Min(_column, columns) - at(0));
                break;
            case 'G':
                _column = Math.Clamp(at(0), 1, columns);
                break;
            case 'd':
                _row = Math.Clamp(at(0), 1, rows);
                break;
            case 's':
                Save();
                break;
            case 'u':
                Restore();
                break;
        }
    }

    /// <summary>
    /// A scroll region set (CSI top ; bottom r): kept, and the cursor goes home. One whose top isn't above its bottom is
    /// ignored, as xterm.js does.
    /// </summary>
    private void Region(int[] numbers)
    {
        var top = numbers.Length > 0 && numbers[0] > 0 ? numbers[0] : 1;
        var bottom = numbers.Length > 1 && numbers[1] > 0 ? Math.Min(numbers[1], rows) : rows;
        if (top >= bottom)
        {
            return;
        }
        _bottom = bottom;
        (_row, _column) = (1, 1);
    }
}
