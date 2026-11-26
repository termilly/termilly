using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// The last simple command of a shell command line, as the program it starts gets it: bash -c runs that one in its
/// own place (exec), so its process shows only those words, quotes gone. <c>cd /tmp &amp;&amp; exec python3 -c 'x; y'</c>
/// gives <c>python3 -c x; y</c>.
/// </summary>
internal static class ShellLastCommand
{
    /// <summary>What splits commands at the top level (outside quotes).</summary>
    private const string Separators = ";&|\n";

    /// <summary>What may come before a redirection, naming the file it redirects (2&gt;, &amp;&gt;).</summary>
    private static readonly char[] FileNumber = [.. "0123456789&"];

    /// <summary>What a backslash escapes inside double quotes.</summary>
    private const string EscapedInDoubleQuotes = "$`\"\\\n";

    /// <summary>The words of the last command, as its program's arguments, joined by spaces; null when there are none.</summary>
    public static string? Of(string commandLine)
    {
        var words = Words(SpacedRedirects(LastPart(WithoutComments(commandLine)))).ToList();
        // Assignments before it (FOO=1 cmd) and an exec are the shell's, not the program's.
        var start = 0;
        while (start < words.Count && (words[start].Assignment || words[start].Text == "exec"))
        {
            start++;
        }
        var kept = words.Skip(start).Where(w => !w.Redirect).Select(w => w.Text).ToList();
        return kept.Count == 0 ? null : string.Join(' ', kept);
    }

    /// <summary>The text after the last separator outside quotes, with what's left of a heredoc body before it.</summary>
    private static string LastPart(string commandLine)
    {
        var last = 0;
        char? quote = null;
        for (var i = 0; i < commandLine.Length; i++)
        {
            var c = commandLine[i];
            if (c == '\\' && quote != '\'')
            {
                i++;
            }
            else if (quote is { } open)
            {
                quote = c == open ? null : quote;
            }
            else if (c is '\'' or '"')
            {
                quote = c;
            }
            else if (Separators.Contains(c, StringComparison.Ordinal) && !InRedirect(commandLine, i))
            {
                last = i + 1;
            }
        }
        return commandLine[last..];
    }

    /// <summary>The command line without its comments: a # that starts a word, outside quotes, to the line's end.</summary>
    private static string WithoutComments(string commandLine)
    {
        var kept = new StringBuilder();
        char? quote = null;
        for (var i = 0; i < commandLine.Length; i++)
        {
            var c = commandLine[i];
            var wordStart = i == 0 || char.IsWhiteSpace(commandLine[i - 1]) || Separators.Contains(commandLine[i - 1], StringComparison.Ordinal);
            if (quote is null && c == '#' && wordStart)
            {
                var lineEnd = commandLine.IndexOf('\n', i);
                if (lineEnd < 0)
                {
                    break;
                }
                i = lineEnd - 1;
                continue;
            }
            kept.Append(c);
            if (c == '\\' && quote != '\'' && i + 1 < commandLine.Length)
            {
                kept.Append(commandLine[++i]);
            }
            else if (quote is { } open)
            {
                quote = c == open ? null : quote;
            }
            else if (c is '\'' or '"')
            {
                quote = c;
            }
        }
        return kept.ToString();
    }

    /// <summary>
    /// The part with a space before each redirection outside quotes, so it's a word of its own: <c>sleep 5&gt;/tmp/out</c>
    /// is <c>sleep</c> and the redirection <c>5&gt;/tmp/out</c> (digits just before it are the file it redirects).
    /// </summary>
    private static string SpacedRedirects(string part)
    {
        var spaced = new StringBuilder();
        char? quote = null;
        for (var i = 0; i < part.Length; i++)
        {
            var c = part[i];
            if (quote is null && c is '>' or '<' && spaced.Length > 0 && spaced[^1] is not ('>' or '<'))
            {
                var wordStart = spaced.Length;
                while (wordStart > 0 && !char.IsWhiteSpace(spaced[wordStart - 1]))
                {
                    wordStart--;
                }
                var before = spaced.ToString(wordStart, spaced.Length - wordStart);
                spaced.Insert(before.All(d => char.IsDigit(d) || d == '&') ? wordStart : spaced.Length, ' ');
            }
            spaced.Append(c);
            if (c == '\\' && quote != '\'' && i + 1 < part.Length)
            {
                spaced.Append(part[++i]);
            }
            else if (quote is { } open)
            {
                quote = c == open ? null : quote;
            }
            else if (c is '\'' or '"')
            {
                quote = c;
            }
        }
        return spaced.ToString();
    }

    /// <summary>Whether the &amp; at <paramref name="i"/> is part of a redirection (2&gt;&amp;1, &amp;&gt;file), not a separator.</summary>
    private static bool InRedirect(string text, int i) =>
        text[i] == '&' && ((i > 0 && text[i - 1] is '>' or '<') || (i + 1 < text.Length && text[i + 1] == '>'));

    /// <summary>A word as the program gets it, and whether it's an assignment or a redirection rather than an argument.</summary>
    private sealed record Word(string Text, bool Assignment, bool Redirect);

    private static IEnumerable<Word> Words(string part)
    {
        var text = new StringBuilder();
        var raw = new StringBuilder();
        var redirectTarget = false;
        char? quote = null;
        for (var i = 0; i <= part.Length; i++)
        {
            var c = i < part.Length ? part[i] : ' ';
            if (quote is null && char.IsWhiteSpace(c))
            {
                if (raw.Length > 0)
                {
                    var word = raw.ToString();
                    var redirect = redirectTarget || word.TrimStart(FileNumber).StartsWith('>') || word.TrimStart(FileNumber).StartsWith('<');
                    // ">" alone redirects to the word after it.
                    redirectTarget = word is ">" or ">>" or "<" or "2>" or "&>" or "1>" or "2>>";
                    yield return new Word(text.ToString(), Assignment: !redirect && IsAssignment(word), redirect || redirectTarget);
                }
                text.Clear();
                raw.Clear();
                continue;
            }
            raw.Append(c);
            // In double quotes a backslash escapes only $ ` " \ and a line break; before anything else it stays.
            if (c == '\\' && quote == '"' && i + 1 < part.Length && !EscapedInDoubleQuotes.Contains(part[i + 1], StringComparison.Ordinal))
            {
                text.Append(c);
            }
            else if (c == '\\' && quote != '\'' && i + 1 < part.Length)
            {
                raw.Append(part[++i]);
                text.Append(part[i]);
            }
            else if (quote is { } open && c == open)
            {
                quote = null;
            }
            else if (quote is null && c is '\'' or '"')
            {
                quote = c;
            }
            else
            {
                text.Append(c);
            }
        }
    }

    /// <summary>NAME=value, as a shell takes it before a command.</summary>
    private static bool IsAssignment(string word)
    {
        var equals = word.IndexOf('=', StringComparison.Ordinal);
        return equals > 0 && word[..equals].All(c => char.IsLetterOrDigit(c) || c == '_') && !char.IsDigit(word[0]);
    }
}
