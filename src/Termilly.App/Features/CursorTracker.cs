namespace Termilly.Desktop.Features;

/// <summary>
/// Where a terminal's cursor is, followed from what its shell prints before the page draws it (EarlyShell): text and
/// its wrapping at the terminal's width, line breaks, carriage returns, backspaces, and the cursor moves shells and
/// their prompts use (CSI H, f, A, B, C, D, G, d). Other sequences move nothing. Enough to
/// answer "where's the cursor" (CSI 6 n) as a shell starts, which PowerShell asks at each prompt and waits for.
/// </summary>
internal sealed class CursorTracker(int columns, int rows)
{
    private const char Escape = '\u001b';
    private const char Bell = '\u0007';

    private int _row = 1;
    private int _column = 1;
    /// <summary>A sequence split between two chunks of output: its start, finished by the next.</summary>
    private string _pending = "";

    /// <summary>Its place, as the answer to CSI 6 n gives it: CSI row ; column R.</summary>
    public string Report => $"{Escape}[{_row};{Math.Min(_column, columns)}R"; // a full line waits in its last column to wrap

    /// <summary>Follows the cursor through output, up to <paramref name="end"/> (the whole of it by default).</summary>
    public void Follow(string output, int end = -1)
    {
        var text = _pending + output[..(end < 0 ? output.Length : end)];
        _pending = "";
        for (var i = 0; i < text.Length;)
        {
            var c = text[i];
            if (c == Escape)
            {
                var length = SequenceLength(text, i);
                if (length == 0)
                {
                    _pending = text[i..]; // not finished yet: the next chunk has the rest
                    return;
                }
                Move(text.Substring(i, length));
                i += length;
                continue;
            }
            Character(c);
            i++;
        }
    }

    private void Character(char c)
    {
        switch (c)
        {
            case '\r':
                _column = 1;
                break;
            case '\n':
                Down(1);
                break;
            case '\b':
                _column = Math.Max(1, _column - 1);
                break;
            default:
                if (!char.IsControl(c) && !char.IsLowSurrogate(c))
                {
                    if (_column > columns)
                    {
                        _column = 1;
                        Down(1);
                    }
                    _column++;
                }
                break;
        }
    }

    private void Down(int lines) => _row = Math.Min(rows, _row + lines);

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

    /// <summary>A CSI sequence that moves the cursor; others leave it.</summary>
    private void Move(string sequence)
    {
        if (sequence.Length < 3 || sequence[1] != '[')
        {
            return;
        }
        var final = sequence[^1];
        var parameters = sequence[2..^1];
        if (parameters.Length > 0 && !char.IsDigit(parameters[0]) && parameters[0] != ';')
        {
            return; // private (CSI ? …): modes, not moves
        }
        var numbers = parameters.Split(';').Select(p => int.TryParse(p, out var n) ? n : 0).ToArray();
        int At(int index) => index < numbers.Length && numbers[index] > 0 ? numbers[index] : 1;
        switch (final)
        {
            case 'H' or 'f':
                (_row, _column) = (Math.Clamp(At(0), 1, rows), Math.Clamp(At(1), 1, columns));
                break;
            case 'A':
                _row = Math.Max(1, _row - At(0));
                break;
            case 'B':
                Down(At(0));
                break;
            case 'C':
                _column = Math.Min(columns, _column + At(0));
                break;
            case 'D':
                _column = Math.Max(1, _column - At(0));
                break;
            case 'G':
                _column = Math.Clamp(At(0), 1, columns);
                break;
            case 'd':
                _row = Math.Clamp(At(0), 1, rows);
                break;
        }
    }
}
