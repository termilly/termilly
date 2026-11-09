using System.IO;
using System.Text;

namespace Termilly.Desktop;

/// <summary>
/// The file in a project that holds the rules carried over from Claude Code to Codex (<see cref="AgentRules"/>):
/// <c>.codex/rules/termilly.rules</c>, which Codex reads with the project's other rules. Termilly's lines in it carry a
/// mark and are written anew each time, so an allow that stopped being safe goes; every other line there is the user's
/// and is left exactly as it is.
/// </summary>
internal static class AgentRulesFile
{
    private const string CodexFolder = ".codex";
    private const string RulesFolder = "rules";
    private const string OwnRulesFile = "termilly.rules";
    /// <summary>What ends each of Termilly's lines in the rules file: they're its to write anew, the others aren't.</summary>
    internal const string Mark = "  # from Claude Code, by Termilly";

    private const string Header =
        "# Commands Claude Code's settings allow, ask about or deny in this project, copied here by Termilly so Codex treats\n" +
        "# them the same. The lines Termilly marks are written anew each time you copy; lines without the mark are yours and\n" +
        "# are left as they are. Delete the file to undo it all.\n";

    /// <summary>The file Termilly keeps a project's carried-over rules in.</summary>
    public static string PathIn(string project) => Path.Combine(project, CodexFolder, RulesFolder, OwnRulesFile);

    /// <summary>A rule's line in the file, with Termilly's mark.</summary>
    internal static string Line(IReadOnlyList<string> prefix, string decision) =>
        new StringBuilder("prefix_rule(pattern=[").AppendJoin(", ", prefix.Select(Quoted)).Append("], decision=\"").Append(decision).Append("\")").Append(Mark).ToString();

    /// <summary>
    /// A word as a string of the rules file: in double quotes, with a backslash before each backslash and quote. A word
    /// has neither (AgentRules keeps such words behind), nor a line break or control character; they're escaped all the same.
    /// </summary>
    private static string Quoted(string word)
    {
        var text = new StringBuilder("\"");
        foreach (var c in word)
        {
            text.Append(c switch
            {
                '\\' => "\\\\",
                '"' => "\\\"",
                < ' ' or '\x7F' => $"\\x{(int)c:x2}",
                _ => c.ToString(),
            });
        }
        return text.Append('"').ToString();
    }

    /// <summary>
    /// The file's text with these rules as Termilly's lines: the lines it marked before go (an allow among them may have
    /// stopped being safe), every other line stays exactly as it was, and the rules that carry over are written at the end.
    /// </summary>
    internal static string Merge(string? existing, IEnumerable<AgentRules.Rule> rules)
    {
        var kept = string.IsNullOrEmpty(existing)
            ? Header
            : string.Concat(existing.Split('\n').Where(line => !line.TrimEnd('\r').EndsWith(Mark, StringComparison.Ordinal)).Select((line, i) => i == 0 ? line : "\n" + line));
        var text = new StringBuilder(kept);
        if (text.Length > 0 && text[^1] != '\n')
        {
            text.Append('\n');
        }
        foreach (var rule in rules.Where(r => r.Prefix is not null))
        {
            text.Append(Line(rule.Prefix!, rule.Decision)).Append('\n');
        }
        return text.ToString();
    }

    /// <summary>How many of Termilly's rules a rules file's text holds.</summary>
    internal static int Count(string text) => text.Split('\n').Count(line => line.TrimEnd('\r').EndsWith(Mark, StringComparison.Ordinal));

    /// <summary>How many of Termilly's rules a project's file holds; none when it isn't there or can't be read.</summary>
    internal static int CountIn(string path)
    {
        try
        {
            return File.Exists(path) ? Count(File.ReadAllText(path)) : 0;
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            return 0;
        }
    }

    /// <summary>Writes the rules that carry over as Termilly's lines of the project's file, and says how many there are.</summary>
    public static int Write(IEnumerable<AgentRules.Rule> rules, string path)
    {
        var text = Merge(File.Exists(path) ? File.ReadAllText(path) : null, rules);
        AppPaths.WriteAtomically(path, text);
        return Count(text);
    }
}
