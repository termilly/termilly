namespace Termilly.Pty;

/// <summary>A process attached to a pseudo terminal.</summary>
public interface IPty : IDisposable
{
    int ProcessId { get; }

    /// <summary>Bytes typed into the terminal. Write UTF-8.</summary>
    Stream Input { get; }

    /// <summary>VT-encoded output. Ends (read returns 0) after the process exits.</summary>
    Stream Output { get; }

    /// <summary>Completes with the exit code when the process exits.</summary>
    Task<int> Exited { get; }

    void Resize(int columns, int rows);
}

/// <param name="Environment">Variables to set (or override) on top of this process's environment.</param>
public sealed record PtyOptions(
    string CommandLine,
    int Columns = PtyOptions.DefaultColumns,
    int Rows = PtyOptions.DefaultRows,
    string? WorkingDirectory = null,
    IReadOnlyDictionary<string, string>? Environment = null)
{
    /// <summary>The size a terminal starts at before the page has measured it.</summary>
    public const int DefaultColumns = 120;
    public const int DefaultRows = 30;
}

/// <summary>How terminal output is read: in chunks of this many bytes (the pseudo console's, tmux's, the host's pipe).</summary>
public static class TerminalStreams
{
    public const int ReadSize = 16 * 1024;
}

/// <summary>Variables about the terminal itself that shells and programs read.</summary>
public static class TerminalVariables
{
    /// <summary>The terminal type programs look up, and the one Termilly's terminals are: xterm with 256 colours.</summary>
    public const string Term = "TERM";
    public const string Xterm256Color = "xterm-256color";
    /// <summary>Windows Terminal's own: inherited from one that started Termilly, they'd claim a terminal these shells aren't in.</summary>
    public const string WindowsTerminalSession = "WT_SESSION";
    public const string WindowsTerminalProfile = "WT_PROFILE_ID";
    /// <summary>Says the terminal shows 24-bit colour.</summary>
    public const string ColorTerm = "COLORTERM";
    public const string TrueColor = "truecolor";
}

/// <summary>The variables a terminal's program starts with.</summary>
public static class ShellEnvironment
{
    /// <summary>
    /// This process's variables, named as <paramref name="names"/> compares them (Windows ignores case), changed by
    /// <paramref name="adjust"/>, then with <paramref name="overrides"/> applied (an empty value removes a variable),
    /// sorted by name.
    /// </summary>
    public static SortedDictionary<string, string> Merge(
        IReadOnlyDictionary<string, string>? overrides, StringComparer names, Action<SortedDictionary<string, string>>? adjust = null)
    {
        var vars = new SortedDictionary<string, string>(names);
        foreach (System.Collections.DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
        {
            vars[(string)entry.Key] = (string?)entry.Value ?? "";
        }
        adjust?.Invoke(vars);
        foreach (var (name, value) in overrides ?? new Dictionary<string, string>())
        {
            if (string.IsNullOrEmpty(value))
            {
                vars.Remove(name);
            }
            else
            {
                vars[name] = value;
            }
        }
        return vars;
    }
}

/// <summary>Builds the environment block CreateProcess takes.</summary>
public static class EnvironmentBlock
{
    /// <summary>
    /// This process's variables with <paramref name="overrides"/> applied (matched without regard to case, as
    /// Windows does), sorted by name, as "NAME=value\0…\0\0". An empty override value removes the variable.
    /// </summary>
    public static string Build(IReadOnlyDictionary<string, string> overrides)
    {
        var block = new System.Text.StringBuilder();
        foreach (var (name, value) in ShellEnvironment.Merge(overrides, StringComparer.OrdinalIgnoreCase))
        {
            block.Append(name).Append('=').Append(value).Append('\0');
        }
        return block.Append('\0').ToString();
    }
}
