using System.Text;

namespace Termilly.Pty.Unix;

/// <summary>Splits a profile's command line into arguments the way a POSIX shell would (without expanding anything).</summary>
public static class CommandLine
{
    /// <summary>What a backslash escapes inside double quotes; before anything else it stays a backslash.</summary>
    private const string EscapedInDoubleQuotes = "\"\\$`";

    /// <summary>
    /// Words separated by spaces or tabs. 'single quotes' keep everything as is; "double quotes" let \" \\ \$ \` be
    /// escaped; outside quotes a backslash keeps the next character.
    /// </summary>
    public static List<string> Split(string commandLine)
    {
        var args = new List<string>();
        var word = new StringBuilder();
        var inWord = false;
        for (var i = 0; i < commandLine.Length; i++)
        {
            var c = commandLine[i];
            switch (c)
            {
                case ' ' or '\t':
                    if (inWord)
                    {
                        args.Add(word.ToString());
                        word.Clear();
                        inWord = false;
                    }
                    break;
                case '\'':
                    inWord = true;
                    i = SingleQuoted(commandLine, i, word);
                    break;
                case '"':
                    inWord = true;
                    i = DoubleQuoted(commandLine, i, word);
                    break;
                case '\\' when i + 1 < commandLine.Length:
                    inWord = true;
                    word.Append(commandLine[++i]);
                    break;
                default:
                    inWord = true;
                    word.Append(c);
                    break;
            }
        }
        if (inWord)
        {
            args.Add(word.ToString());
        }
        return args;
    }

    /// <summary>Adds what's inside the quotes that open at <paramref name="i"/>; returns where they close.</summary>
    private static int SingleQuoted(string commandLine, int i, StringBuilder word)
    {
        while (++i < commandLine.Length && commandLine[i] != '\'')
        {
            word.Append(commandLine[i]);
        }
        return i;
    }

    /// <summary>The same for double quotes, where a backslash escapes some characters.</summary>
    private static int DoubleQuoted(string commandLine, int i, StringBuilder word)
    {
        while (++i < commandLine.Length && commandLine[i] != '"')
        {
            if (commandLine[i] == '\\' && i + 1 < commandLine.Length && EscapedInDoubleQuotes.Contains(commandLine[i + 1]))
            {
                i++;
            }
            word.Append(commandLine[i]);
        }
        return i;
    }
}
