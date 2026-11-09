using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

namespace Termilly.Desktop;

/// <summary>
/// The commands Claude Code's settings allow, ask about or deny in a project, carried over to Codex for that project, so
/// what the user approved for one agent needn't be approved again for the other. The two keep them differently and can't
/// share a file: Claude Code has permission rules in its settings (<c>Bash(git diff *)</c>), Codex has prefix rules in
/// <c>.rules</c> files (<c>prefix_rule(pattern=["git", "diff"], decision="allow")</c>).
/// <para>
/// Codex must never end up allowing more than Claude Code does. So everything goes to the project's own
/// <c>.codex/rules/termilly.rules</c>, never to Codex's rules for every folder (a project's approval isn't one for
/// another project); only what means the same in Codex is carried over; and whatever makes that uncertain keeps every
/// allow behind: a settings file that can't be read, an organization's managed settings (which can't all be read from
/// here), or a restriction Codex has no counterpart for that touches the same commands. A rule that asks or denies may
/// get wider on the way, never narrower.
/// </para>
/// Termilly's lines in that file carry a mark and are written anew each time, so an allow that stopped being safe goes;
/// every other line there is the user's and is left as it is.
/// </summary>
internal static partial class AgentRules
{
    /// <summary>Codex's decisions: run without asking, ask each time, never run.</summary>
    public static class Decisions
    {
        public const string Allow = "allow";
        public const string Prompt = "prompt";
        public const string Forbidden = "forbidden";
    }

    /// <summary>Where Claude Code's settings keep their rules, and Codex's decision for each list.</summary>
    private static readonly (string List, string Decision)[] Lists = [("allow", Decisions.Allow), ("ask", Decisions.Prompt), ("deny", Decisions.Forbidden)];

    private const string PermissionsKey = "permissions";
    private const string ManagedOnlyKey = "allowManagedPermissionRulesOnly";
    private const string CodexFolder = ".codex";
    private const string RulesFolder = "rules";
    private const string OwnRulesFile = "termilly.rules";
    private const string GitFolder = ".git";
    private const string PowerShellTool = "PowerShell";
    /// <summary>What ends each of Termilly's lines in the rules file: they're its to write anew, the others aren't.</summary>
    internal const string Mark = "  # from Claude Code, by Termilly";
    /// <summary>A settings file larger than this isn't one a person keeps rules in.</summary>
    internal const long MaxSettingsBytes = 1024 * 1024;
    /// <summary>The most rules looked at; with more, what restricts what can't be told for sure.</summary>
    internal const int MaxRules = 2000;

    private const string Header =
        "# Commands Claude Code's settings allow, ask about or deny in this project, copied here by Termilly so Codex treats\n" +
        "# them the same. The lines Termilly marks are written anew each time you copy; lines without the mark are yours and\n" +
        "# are left as they are. Delete the file to undo it all.\n";

    private const string EveryCommand = "It's for every command; Codex's rules are for one each.";
    private const string NotACommand = "Not for a command: files, the web and tools are for Codex's sandbox.";
    private const string NotPlainCommand = "Not one plain command: it has wildcards, quotes, escapes or operators in it.";
    private const string OnlyExact = "It allows this exact command only; Codex's rule would allow whatever follows it too.";
    private const string PowerShellAllow = "Claude Code matches PowerShell rules whatever the case and by alias; Codex's rule wouldn't mean the same.";
    private const string RunsOthers = "Claude Code still asks for some of what this command can run or delete; Codex's rule wouldn't.";
    private const string Managed = "Your organization manages Claude Code's settings here; what it restricts can't be read for sure, so no allow is copied.";
    private const string ManagedOnly = "Your organization's settings say only its own rules count.";
    private const string TooMany = "There are too many rules to tell what restricts what, so no allow is copied.";
    private const string Spacing = "Its spacing is part of the rule in Claude Code; Codex's rule wouldn't keep it.";
    private const string ReadsFiles = "Claude Code checks the files this command reads or writes against your file rules; Codex's rule wouldn't.";

    /// <summary>
    /// Commands whose files Claude Code checks against the user's file rules (a denied Read(.env) stops cat .env too):
    /// with a file rule that asks or denies, an allow for one of these stays. tee's are checked whatever the rules.
    /// </summary>
    private static readonly HashSet<string> FileCommands = new(StringComparer.OrdinalIgnoreCase)
    {
        "cat", "head", "tail", "less", "more", "tee", "cp", "mv", "ln", "dd", "sed", "awk", "grep", "rg", "xxd", "od", "strings", "base64", "tar",
        "zip", "unzip", "sort", "uniq", "cut", "wc", "diff", "nl", "tac", "bat", "type", "touch", "truncate", "install", "rsync", "scp",
    };
    private const string AlwaysChecked = "tee";

    /// <summary>Claude Code's tools that run commands.</summary>
    private static readonly string[] CommandTools = ["Bash", PowerShellTool];

    /// <summary>A command rule that's about how a command is run, not which (Bash(run_in_background:true)): it may be any command.</summary>
    [GeneratedRegex(@"^\w+:[^*\s]\S*$")]
    private static partial Regex ByParameter();

    /// <summary>Claude Code's rules for files: what's read, written or searched.</summary>
    [GeneratedRegex(@"^(?:Read|Edit|Write|MultiEdit|NotebookEdit|Glob|Grep)(?:\(|$)")]
    private static partial Regex FileRule();

    /// <summary>
    /// Commands a prefix rule can't approve all of in Claude Code: they run another command, or (find) can delete and
    /// write. Claude Code asks for those uses whatever the rule says; Codex's rule would let them through.
    /// </summary>
    private static readonly HashSet<string> RunOthers = new(StringComparer.OrdinalIgnoreCase)
    {
        "find", "watch", "setsid", "ionice", "flock", "xargs", "env", "sudo", "doas", "su", "runuser", "nice", "nohup", "timeout", "time",
        "stdbuf", "command", "builtin", "exec", "eval", "chroot", "unshare", "nsenter", "strace", "ltrace", "script", "parallel", "entr",
    };

    /// <summary>Claude Code's tools that run commands (Bash, PowerShell), with what's in the brackets when there is any.</summary>
    [GeneratedRegex(@"^(Bash|PowerShell)(?:\((.*)\))?$", RegexOptions.Singleline)]
    private static partial Regex CommandRule();

    /// <summary>
    /// What a shell reads as more than a word, or a word can't hold: wildcards, operators, quotes, escapes, a comment, a
    /// variable, a control character. A rule with any of it isn't one plain command.
    /// </summary>
    [GeneratedRegex(@"[*?|&;<>$(){}\[\]`'""\\#~!\x00-\x08\x0A-\x1F\x7F]")]
    private static partial Regex NotPlain();

    /// <summary>A word that sets a variable for the command (NAME=value git push): the command isn't the first word then.</summary>
    [GeneratedRegex(@"^\w+=")]
    private static partial Regex Assignment();

    /// <summary>A rule of Claude Code's as read: its text, Codex's decision for it, where it's from, and its command when it carries over.</summary>
    /// <param name="Prefix">The command's first words, or null when it isn't carried over.</param>
    /// <param name="Why">Why it stays, when it does.</param>
    internal sealed record Rule(string Text, string Decision, string Source, IReadOnlyList<string>? Prefix, string? Why);

    /// <summary>
    /// What a copy would do: the rules as read, the project's file those that carry over go to (null with no project), and
    /// how many rules Termilly wrote there before, which this copy replaces.
    /// </summary>
    internal sealed record Plan(IReadOnlyList<Rule> Rules, string? File, int Existing);

    /// <summary>A settings file to read: whether its allows count here, or only what it asks about and denies.</summary>
    private sealed record Settings(string Path, string Source, bool Allows);

    /// <summary>
    /// The project a folder belongs to: the nearest folder on the way up that holds a git repository, else the folder.
    /// Claude Code keeps a project's approvals at its repository's root, and that's where Codex looks for a project's rules.
    /// </summary>
    internal static string? ProjectOf(string? folder)
    {
        if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder))
        {
            return null;
        }
        for (var at = new DirectoryInfo(folder); at is not null; at = at.Parent)
        {
            var git = Path.Combine(at.FullName, GitFolder);
            if (Directory.Exists(git) || File.Exists(git))
            {
                return at.FullName;
            }
        }
        return Path.GetFullPath(folder);
    }

    /// <summary>The file Termilly keeps a project's carried-over rules in.</summary>
    public static string RulesPath(string project) => Path.Combine(project, CodexFolder, RulesFolder, OwnRulesFile);

    /// <summary>
    /// What a copy in <paramref name="folder"/> would do. Allows count from the user's own settings and the project's two
    /// files; what's asked about or denied counts from those and from every folder on the way up as well, since reading
    /// one restriction too many only makes Codex ask more. Each file is read once.
    /// </summary>
    /// <param name="managed">Whether an organization manages Claude Code's settings on this computer; looked up when not given.</param>
    public static Plan Read(string? folder, string claudeDirectory, bool? managed = null)
    {
        var project = ProjectOf(folder);
        var files = new List<Settings> { new(Path.Combine(claudeDirectory, ClaudeCodeFiles.Settings), "your Claude Code settings", Allows: true) };
        if (project is not null)
        {
            var name = new DirectoryInfo(project).Name;
            files.Add(new(Path.Combine(project, ClaudeCodeFiles.Folder, ClaudeCodeFiles.Settings), name, Allows: true));
            files.Add(new(Path.Combine(project, ClaudeCodeFiles.Folder, ClaudeCodeFiles.LocalSettings), name, Allows: true));
        }
        for (var at = folder is null || project is null ? null : new DirectoryInfo(folder); at is not null; at = at.Parent)
        {
            files.Add(new(Path.Combine(at.FullName, ClaudeCodeFiles.Folder, ClaudeCodeFiles.Settings), at.Name, Allows: false));
            files.Add(new(Path.Combine(at.FullName, ClaudeCodeFiles.Folder, ClaudeCodeFiles.LocalSettings), at.Name, Allows: false));
        }
        var names = OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var rules = new List<Rule>();
        string? unsure = (managed ?? IsManaged()) ? Managed : null;
        // The first of a file's entries wins: the ones whose allows count come first.
        foreach (var file in files.DistinctBy(f => Path.GetFullPath(f.Path), names))
        {
            var (read, problem) = ReadFile(file);
            rules.AddRange(read);
            unsure ??= problem;
        }
        var distinct = rules.DistinctBy(r => (r.Text, r.Decision)).ToList();
        unsure ??= distinct.Count > MaxRules ? TooMany : null;
        var constrained = unsure is null ? Constrain(distinct) : distinct.Select(r => r.Decision == Decisions.Allow && r.Prefix is not null ? r with { Prefix = null, Why = unsure } : r).ToList();
        var target = project is null ? null : RulesPath(project);
        return new Plan(constrained.Take(MaxRules).ToList(), target, target is null ? 0 : CountIn(target));
    }

    /// <summary>
    /// One settings file's rules, and what's wrong with it when it can't be relied on: a file that's there but can't be
    /// read, is broken or is too large may hold a restriction, so nothing may be allowed past it.
    /// </summary>
    private static (IReadOnlyList<Rule> Rules, string? Problem) ReadFile(Settings file)
    {
        try
        {
            // Opened, not asked whether it's there: a file that can't be looked at isn't one that's surely absent.
            using var stream = new FileStream(file.Path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            if (stream.Length > MaxSettingsBytes)
            {
                return ([], $"{file.Path} is too large to read, so what it restricts isn't known and no allow is copied.");
            }
            using var reader = new StreamReader(stream, Encoding.UTF8);
            var (rules, managedOnly) = FromSettings(reader.ReadToEnd(), file.Source, file.Allows);
            return (rules, managedOnly ? ManagedOnly : null);
        }
        catch (Exception e) when (e is FileNotFoundException or DirectoryNotFoundException)
        {
            return ([], null);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException or JsonException or NotSupportedException or ArgumentException)
        {
            return ([], $"{file.Path} couldn't be read, so what it restricts isn't known and no allow is copied.");
        }
    }

    /// <summary>
    /// The rules in one settings file's text, each as it would carry over by itself, and whether the file says only an
    /// organization's rules count. Claude Code reads strict JSON, so that's what is read here.
    /// </summary>
    /// <param name="allows">Whether the file's allows count; when not, only what it asks about and denies is read.</param>
    internal static (IReadOnlyList<Rule> Rules, bool ManagedOnly) FromSettings(string json, string source, bool allows = true)
    {
        using var document = JsonDocument.Parse(json);
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object)
        {
            return ([], false);
        }
        var managedOnly = root.TryGetProperty(ManagedOnlyKey, out var only) && only.ValueKind == JsonValueKind.True;
        if (!root.TryGetProperty(PermissionsKey, out var permissions) || permissions.ValueKind != JsonValueKind.Object)
        {
            return ([], managedOnly);
        }
        var rules = new List<Rule>();
        foreach (var (list, decision) in Lists.Where(l => allows || l.Decision != Decisions.Allow))
        {
            if (!permissions.TryGetProperty(list, out var entries) || entries.ValueKind != JsonValueKind.Array)
            {
                continue;
            }
            foreach (var text in entries.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString() ?? ""))
            {
                var (prefix, why) = Translate(text, decision);
                rules.Add(new Rule(text, decision, source, prefix, why));
            }
        }
        return (rules, managedOnly);
    }

    /// <summary>
    /// A rule of Claude Code's as a command's first words, which is what Codex's rules match: <c>Bash(git diff *)</c> and
    /// <c>Bash(git diff:*)</c> are "git diff and whatever follows". Null, with why, for what stays. As an allow these stay
    /// too: a rule for one exact command (<c>Bash(npm test)</c>; Codex's would allow what follows it), one for PowerShell
    /// (matched by alias and whatever the case there), and one for a command that runs others or, as find, can delete
    /// (Claude Code still asks for those uses). Asked about or denied, they're carried over, wider if anything.
    /// </summary>
    internal static (IReadOnlyList<string>? Prefix, string? Why) Translate(string rule, string decision = Decisions.Allow)
    {
        var match = CommandRule().Match(rule.Trim());
        if (!match.Success)
        {
            return (null, NotACommand);
        }
        var command = match.Groups[2].Value.Trim();
        var exact = true;
        foreach (var ending in new[] { ":*", " *" })
        {
            if (command.EndsWith(ending, StringComparison.Ordinal))
            {
                command = command[..^ending.Length].TrimEnd();
                exact = false;
                break;
            }
        }
        if (command.Length == 0 || command == "*")
        {
            return (null, EveryCommand);
        }
        var words = command.Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries);
        if (NotPlain().IsMatch(command) || Assignment().IsMatch(words[0]))
        {
            return (null, NotPlainCommand);
        }
        if (decision != Decisions.Allow)
        {
            return (words, null);
        }
        // Claude Code matches a rule's text as written: with two spaces between its words it isn't the command with one.
        if (command != string.Join(' ', words))
        {
            return (null, Spacing);
        }
        var stays = exact ? OnlyExact : match.Groups[1].Value == PowerShellTool ? PowerShellAllow : RunOthers.Contains(Path.GetFileName(words[0])) ? RunsOthers : null;
        return stays is null ? (words, null) : (null, stays);
    }

    /// <summary>
    /// The words a command rule surely starts with: all of them for a plain one, those before its first wildcard or
    /// operator otherwise; none when it could be any command. Null for a rule that isn't about commands.
    /// </summary>
    internal static IReadOnlyList<string>? LeadingWords(string rule)
    {
        var match = CommandRule().Match(rule.Trim());
        if (!match.Success)
        {
            return null;
        }
        var words = new List<string>();
        foreach (var word in match.Groups[2].Value.Trim().Split((char[]?)null, StringSplitOptions.RemoveEmptyEntries))
        {
            var plain = word.EndsWith(":*", StringComparison.Ordinal) ? word[..^2] : word;
            if (plain.Length == 0 || NotPlain().IsMatch(plain) || Assignment().IsMatch(plain))
            {
                break;
            }
            words.Add(plain);
            if (plain.Length != word.Length)
            {
                break;
            }
        }
        return words;
    }

    /// <summary>
    /// Keeps Codex from allowing what Claude Code restricts: an allow stays behind when a rule that asks or denies, and
    /// that can't be carried over itself, may apply to the same commands (one's first words start the other's, whatever
    /// the case). Carried over without it, the allow would let through what that rule holds back.
    /// </summary>
    internal static IReadOnlyList<Rule> Constrain(IReadOnlyList<Rule> rules)
    {
        var limits = rules.Select(r => (r.Text, Words: LimitOf(r))).Where(l => l.Words is not null).ToList();
        var fileRules = rules.Any(r => r.Decision != Decisions.Allow && FileRule().IsMatch(r.Text.Trim()));
        return rules.Select(rule =>
        {
            if (rule.Decision != Decisions.Allow || rule.Prefix is null)
            {
                return rule;
            }
            var program = Path.GetFileName(rule.Prefix[0]);
            if (string.Equals(program, AlwaysChecked, StringComparison.OrdinalIgnoreCase) || (fileRules && FileCommands.Contains(program)))
            {
                return rule with { Prefix = null, Why = ReadsFiles };
            }
            var limit = limits.FirstOrDefault(l => Overlap(rule.Prefix, l.Words!));
            return limit.Text is null ? rule : rule with { Prefix = null, Why = $"{limit.Text} restricts it and can't be copied as it is, so Codex would allow more than Claude Code does." };
        }).ToList();
    }

    /// <summary>
    /// The commands a rule that asks or denies may hold back beyond what its own line in Codex's file would: their first
    /// words (none: any command), or null when it holds back nothing more. That's a rule Codex has no counterpart for; one
    /// for PowerShell, which Claude Code matches by alias and whatever the case, so its line covers less; one that names
    /// its tool by a pattern; and one about how a command is run rather than which.
    /// </summary>
    internal static IReadOnlyList<string>? LimitOf(Rule rule)
    {
        if (rule.Decision == Decisions.Allow)
        {
            return null;
        }
        var text = rule.Text.Trim();
        if (NamesACommandToolByPattern(text))
        {
            return [];
        }
        var match = CommandRule().Match(text);
        if (!match.Success)
        {
            return null;
        }
        if (ByParameter().IsMatch(match.Groups[2].Value.Trim()))
        {
            return [];
        }
        return rule.Prefix is null || match.Groups[1].Value == PowerShellTool ? LeadingWords(text) : null;
    }

    /// <summary>
    /// Whether a rule names its tool by a pattern that fits a tool that runs commands (*, B*, *Shell): then it's a rule for
    /// every command, whatever Codex's line for it would say. One for other tools only (mcp__*) isn't.
    /// </summary>
    private static bool NamesACommandToolByPattern(string rule)
    {
        var bracket = rule.IndexOf('(', StringComparison.Ordinal);
        var tool = bracket < 0 ? rule : rule[..bracket];
        if (!tool.Contains('*') && !tool.Contains('?'))
        {
            return false;
        }
        var pattern = new Regex("^" + Regex.Escape(tool).Replace(@"\*", ".*").Replace(@"\?", ".") + "$", RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        return CommandTools.Any(pattern.IsMatch);
    }

    /// <summary>Whether two commands' first words can be the same command: one list starts the other.</summary>
    private static bool Overlap(IReadOnlyList<string> a, IReadOnlyList<string> b) =>
        a.Zip(b).All(pair => string.Equals(pair.First, pair.Second, StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Whether an organization manages Claude Code's settings on this computer, as far as files and policies show: its
    /// managed settings file or folder, a Windows policy, or a macOS profile. Settings an organization delivers from
    /// Anthropic's servers leave no sign that can be relied on, and aren't seen.
    /// </summary>
    internal static bool IsManaged()
    {
        const string ManagedFile = "managed-settings.json";
        const string DropIns = "managed-settings.d";
        const string Product = "ClaudeCode";
        const string PolicyKey = @"SOFTWARE\Policies\" + Product;
        string[] folders = OperatingSystem.IsWindows()
            ? [Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), Product), Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), Product)]
            : OperatingSystem.IsMacOS() ? ["/Library/Application Support/ClaudeCode"] : ["/etc/claude-code"];
        if (folders.Any(folder => File.Exists(Path.Combine(folder, ManagedFile)) || Directory.Exists(Path.Combine(folder, DropIns))))
        {
            return true;
        }
        if (OperatingSystem.IsMacOS())
        {
            const string Profile = "com.anthropic.claudecode.plist";
            const string Profiles = "/Library/Managed Preferences";
            return File.Exists(Path.Combine(Profiles, Profile)) || File.Exists(Path.Combine(Profiles, Environment.UserName, Profile));
        }
        if (!OperatingSystem.IsWindows())
        {
            return false;
        }
        using var machine = Registry.LocalMachine.OpenSubKey(PolicyKey);
        using var user = Registry.CurrentUser.OpenSubKey(PolicyKey);
        return machine is not null || user is not null;
    }

    /// <summary>A rule's line in the file, with Termilly's mark.</summary>
    internal static string Line(IReadOnlyList<string> prefix, string decision) =>
        new StringBuilder("prefix_rule(pattern=[").AppendJoin(", ", prefix.Select(Quoted)).Append("], decision=\"").Append(decision).Append("\")").Append(Mark).ToString();

    /// <summary>
    /// A word as a string of the rules file: in double quotes, with a backslash before each backslash and quote. A word
    /// has neither (<see cref="NotPlain"/>), nor a line break or control character; they're escaped all the same.
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
    internal static string Merge(string? existing, IEnumerable<Rule> rules)
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
    private static int CountIn(string path)
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
    public static int Write(IEnumerable<Rule> rules, string path)
    {
        var text = Merge(File.Exists(path) ? File.ReadAllText(path) : null, rules);
        AppPaths.WriteAtomically(path, text);
        return Count(text);
    }
}
