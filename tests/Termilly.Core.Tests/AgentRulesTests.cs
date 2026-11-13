using Termilly.Desktop;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Core.Tests;

/// <summary>
/// Claude Code's command rules carried over to Codex's prefix rules, for a project (AgentRules.cs): Codex must never end
/// up allowing more than Claude Code does.
/// </summary>
public sealed class AgentRulesTests : IDisposable
{
    private const string Allow = AgentRules.Decisions.Allow;
    private const string Prompt = AgentRules.Decisions.Prompt;
    private const string Forbidden = AgentRules.Decisions.Forbidden;

    private readonly string _dir = Directory.CreateTempSubdirectory("termilly-rules").FullName;

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static IReadOnlyList<AgentRules.Rule> Rules(string permissions) =>
        AgentRules.Constrain(AgentRules.FromSettings($$"""{ "permissions": {{permissions}} }""", "here").Rules);

    /// <summary>Each rule's command as it carries over, or "-" for one that stays.</summary>
    private static string[] Commands(IEnumerable<AgentRules.Rule> rules) => rules.Select(r => r.Prefix is null ? "-" : string.Join(' ', r.Prefix)).ToArray();

    /// <summary>A home with Claude Code's folder, and a project in it that's a git repository; the settings files given are written.</summary>
    private (string Claude, string Project) Project(string? user = null, string? shared = null, string? local = null)
    {
        var claude = Directory.CreateDirectory(Path.Combine(_dir, "home", ".claude")).FullName;
        var project = Directory.CreateDirectory(Path.Combine(_dir, "home", "repo")).FullName;
        Directory.CreateDirectory(Path.Combine(project, ".git"));
        Directory.CreateDirectory(Path.Combine(project, ".claude"));
        foreach (var (path, permissions) in new[] { (Path.Combine(claude, "settings.json"), user), (Path.Combine(project, ".claude", "settings.json"), shared), (Path.Combine(project, ".claude", "settings.local.json"), local) })
        {
            if (permissions is not null)
            {
                File.WriteAllText(path, $$"""{ "permissions": {{permissions}} }""");
            }
        }
        return (claude, project);
    }

    [Theory]
    [InlineData("Bash(git diff:*)", "git diff")]
    [InlineData("Bash(git diff *)", "git diff")]
    [InlineData("Bash(gh:*)", "gh")]
    [InlineData("  Bash(git status:*)  ", "git status")]
    [InlineData("Bash(./scripts/check.sh --fast:*)", "./scripts/check.sh --fast")]
    public void An_allow_for_one_plain_command_and_what_follows_becomes_its_first_words(string rule, string words)
    {
        var (prefix, why) = AgentRules.Translate(rule);
        Assert.Equal(words.Split(' '), prefix);
        Assert.Null(why);
    }

    [Theory]
    [InlineData("Read(//c/Users/**)")]
    [InlineData("WebFetch(domain:github.com)")]
    [InlineData("mcp__termilly__list_terminals")]
    [InlineData("Edit")]
    [InlineData("Bash")]
    [InlineData("Bash(*)")]
    [InlineData("Bash(:*)")]
    [InlineData("PowerShell(*)")]
    [InlineData("Bash(git diff* --stat)")]
    [InlineData("Bash(cd * && git status)")]
    [InlineData("Bash(echo $HOME)")]
    [InlineData("Bash(grep \"a b\" file)")]
    [InlineData("Bash(cat file | wc)")]
    [InlineData("Bash(npm run test*)")]
    [InlineData("Bash(cat secret\\ file:*)")] // an escaped space isn't two words
    [InlineData("Bash(FORCE=1 git push:*)")] // the command isn't the first word
    [InlineData("Bash(cat ~/.ssh/id_rsa:*)")]
    [InlineData("Bash(echo hi # note:*)")]
    [InlineData("Bash(git\nstatus:*)")]
    [InlineData("Bash(git\u0001status:*)")]
    public void What_codex_couldnt_treat_the_same_stays_whatever_it_decides(string rule)
    {
        foreach (var decision in new[] { Allow, Prompt, Forbidden })
        {
            var (prefix, why) = AgentRules.Translate(rule, decision);
            Assert.Null(prefix);
            Assert.False(string.IsNullOrEmpty(why));
        }
    }

    [Theory]
    [InlineData("Bash(git)")] // one exact command; as a prefix it would allow every git command
    [InlineData("Bash(npm run test)")]
    [InlineData("PowerShell(Get-ChildItem *)")] // matched by alias and whatever the case in Claude Code
    [InlineData("PowerShell(git commit:*)")]
    [InlineData("Bash(find:*)")] // find . -delete still asks in Claude Code
    [InlineData("Bash(find . -name:*)")]
    [InlineData("Bash(watch *)")]
    [InlineData("Bash(xargs:*)")]
    [InlineData("Bash(sudo apt:*)")]
    [InlineData("Bash(/usr/bin/env node:*)")]
    [InlineData("Bash(TIMEOUT 5 npm test:*)")]
    public void An_allow_codex_would_stretch_stays_but_asked_about_or_denied_it_carries_over(string rule)
    {
        Assert.Null(AgentRules.Translate(rule, Allow).Prefix);
        Assert.False(string.IsNullOrEmpty(AgentRules.Translate(rule, Allow).Why));
        // Wider is the safe side for what restricts.
        Assert.NotNull(AgentRules.Translate(rule, Prompt).Prefix);
        Assert.NotNull(AgentRules.Translate(rule, Forbidden).Prefix);
    }

    [Fact]
    public void Allow_ask_and_deny_become_codexs_three_decisions()
    {
        var (rules, managedOnly) = AgentRules.FromSettings("""{ "permissions": { "allow": ["Bash(git diff:*)", "Read(**)"], "ask": ["Bash(git push:*)"], "deny": ["Bash(rm -rf:*)", 7] } }""", "here");
        Assert.Equal([Allow, Allow, Prompt, Forbidden], rules.Select(r => r.Decision));
        Assert.Equal(["git diff", "-", "git push", "rm -rf"], Commands(rules));
        Assert.All(rules, r => Assert.Equal("here", r.Source));
        Assert.False(managedOnly);
        Assert.Empty(AgentRules.FromSettings("""{ "model": "x" }""", "here").Rules);
        Assert.Empty(AgentRules.FromSettings("""[]""", "here").Rules);
        // From a folder above the project only what restricts is read.
        Assert.Equal([Prompt, Forbidden], AgentRules.FromSettings("""{ "permissions": { "allow": ["Bash(git diff:*)"], "ask": ["Bash(a:*)"], "deny": ["Bash(b:*)"] } }""", "up", allows: false).Rules.Select(r => r.Decision));
        // Claude Code reads strict JSON: a comment makes the file one it wouldn't read either.
        Assert.ThrowsAny<System.Text.Json.JsonException>(() => AgentRules.FromSettings("""{ /* note */ "permissions": {} }""", "here"));
    }

    [Fact]
    public void An_allow_stays_when_a_rule_that_restricts_it_cant_be_copied()
    {
        // git * --force is denied in Claude Code and has no counterpart: with git allowed in Codex, a forced push would run.
        var rules = Rules("""{ "allow": ["Bash(git:*)", "Bash(git diff:*)", "Bash(npm test:*)"], "deny": ["Bash(git * --force)"] }""");
        Assert.Equal(["-", "-", "npm test", "-"], Commands(rules));
        Assert.Contains("Bash(git * --force) restricts it", rules[0].Why);

        // The same for one that asks, and whatever the case (PowerShell's rules match that way).
        Assert.Equal(["-", "npm test", "-"], Commands(Rules("""{ "allow": ["Bash(git push:*)", "Bash(npm test:*)"], "ask": ["Bash(git push * --tags)"] }""")));
        Assert.Equal(["-", "-"], Commands(Rules("""{ "allow": ["Bash(git push:*)"], "deny": ["PowerShell(GIT PUSH * --force)"] }""")));
        // One for another command restricts nothing here.
        Assert.Equal(["git diff", "-"], Commands(Rules("""{ "allow": ["Bash(git diff:*)"], "deny": ["Bash(rm * -rf)"] }""")));
    }

    [Fact]
    public void A_restriction_on_any_command_keeps_every_allow_behind_and_one_that_copies_keeps_none()
    {
        Assert.Equal(["-", "-", "-"], Commands(Rules("""{ "allow": ["Bash(git diff:*)", "Bash(gh:*)"], "deny": ["Bash"] }""")));
        Assert.Equal(["-", "-"], Commands(Rules("""{ "allow": ["Bash(git diff:*)"], "ask": ["Bash(* --force)"] }""")));
        // A deny that carries over needs no allow to stay: Codex takes the stricter of the two itself.
        Assert.Equal(["git", "git push"], Commands(Rules("""{ "allow": ["Bash(git:*)"], "deny": ["Bash(git push:*)"] }""")));
        // Rules that aren't about commands restrict none.
        Assert.Equal(["git", "-"], Commands(Rules("""{ "allow": ["Bash(git:*)"], "deny": ["Read(.env)"] }""")));
    }

    [Fact]
    public void A_powershell_restriction_keeps_allows_behind_though_it_carries_over_itself()
    {
        // Claude Code matches it whatever the case and by alias; its line in Codex's file matches as written only.
        var rules = Rules("""{ "allow": ["Bash(git *)", "Bash(npm test *)"], "deny": ["PowerShell(GIT PUSH *)"] }""");
        Assert.Equal(["-", "npm test", "GIT PUSH"], Commands(rules));
    }

    [Theory]
    [InlineData("*")] // every tool
    [InlineData("B*")]
    [InlineData("*Shell(git *)")]
    [InlineData("Bash(run_in_background:true)")] // how a command is run, not which
    public void A_restriction_that_may_be_for_any_command_keeps_every_allow_behind(string restriction)
    {
        Assert.Equal(["-", "-"], Commands(Rules($$"""{ "allow": ["Bash(npm test *)", "Bash(gh pr *)"], "deny": ["{{restriction}}"] }""")).Take(2));
        Assert.Equal(["-", "-"], Commands(Rules($$"""{ "allow": ["Bash(npm test *)", "Bash(gh pr *)"], "ask": ["{{restriction}}"] }""")).Take(2));
    }

    [Fact]
    public void A_restriction_for_other_tools_only_keeps_none_behind()
    {
        Assert.Equal(["npm test"], Commands(Rules("""{ "allow": ["Bash(npm test *)"], "deny": ["mcp__*", "mcp__github__*", "WebFetch"] }""")).Take(1));
    }

    [Fact]
    public void With_a_file_rule_that_restricts_allows_for_commands_that_read_or_write_files_stay()
    {
        // Claude Code stops cat .env by the denied Read(.env); an allow for cat in Codex would read it.
        var rules = Rules("""{ "allow": ["Bash(cat *)", "Bash(/usr/bin/grep *)", "Bash(npm test *)"], "deny": ["Read(./.env)"] }""");
        Assert.Equal(["-", "-", "npm test", "-"], Commands(rules));
        Assert.Contains("file rules", rules[0].Why);
        // Without one they carry over; tee's files are checked whatever the rules, so it never does.
        Assert.Equal(["cat", "-"], Commands(Rules("""{ "allow": ["Bash(cat *)", "Bash(tee *)"] }""")));
        Assert.Equal(["-", "-"], Commands(Rules("""{ "allow": ["Bash(sed *)"], "ask": ["Edit(src/**)"] }""")));
    }

    [Fact]
    public void An_allow_whose_spacing_is_part_of_it_stays()
    {
        // Two spaces: Claude Code allows only the command written that way, not npm run publish.
        Assert.Null(AgentRules.Translate("Bash(npm  run *)").Prefix);
        Assert.Null(AgentRules.Translate("Bash(npm	run *)").Prefix);
        Assert.Equal(["npm", "run"], AgentRules.Translate("Bash(npm  run *)", Forbidden).Prefix);
    }

    [Fact]
    public void A_copy_knows_how_many_rules_it_wrote_before_so_they_can_be_taken_back()
    {
        var (claude, project) = Project(shared: """{ "allow": ["Bash(git *)"] }""");
        var first = AgentRules.Read(project, claude, managed: false);
        Assert.Equal(0, first.Existing);
        AgentRulesFile.Write(first.Rules, first.File!);

        // Claude Code now restricts git in a way Codex can't express: nothing carries over, and one line waits to be removed.
        File.WriteAllText(Path.Combine(project, ".claude", "settings.json"), """{ "permissions": { "allow": ["Bash(git *)"], "deny": ["Bash(git * --force)"] } }""");
        var second = AgentRules.Read(project, claude, managed: false);
        Assert.Equal(["-", "-"], Commands(second.Rules));
        Assert.Equal(1, second.Existing);
        Assert.Equal(0, AgentRulesFile.Write(second.Rules.Where(r => r.Prefix is not null), second.File!));
        Assert.Equal(0, AgentRules.Read(project, claude, managed: false).Existing);
    }

    [Fact]
    public void A_project_is_its_git_repository_and_its_rules_go_to_its_own_file()
    {
        var (claude, project) = Project(user: """{ "allow": ["Bash(gh pr:*)"] }""", shared: """{ "allow": ["Bash(npm test:*)", "Bash(gh pr:*)"] }""", local: """{ "deny": ["Bash(git push:*)"] }""");
        var deep = Directory.CreateDirectory(Path.Combine(project, "src", "deep")).FullName;

        var plan = AgentRules.Read(deep, claude, managed: false);
        Assert.Equal(["Bash(gh pr:*)", "Bash(npm test:*)", "Bash(git push:*)"], plan.Rules.Select(r => r.Text));
        Assert.Equal(["gh pr", "npm test", "git push"], Commands(plan.Rules));
        Assert.Equal("repo", plan.Rules[1].Source);
        // Never Codex's rules for every folder: a project's approval isn't one for another project.
        Assert.Equal(Path.Combine(project, ".codex", "rules", "termilly.rules"), plan.File);
        Assert.Equal(project, AgentRules.ProjectOf(deep));

        // Without a repository the folder itself is the project; without a folder there's none, and nowhere to write.
        var plain = Directory.CreateDirectory(Path.Combine(_dir, "plain", "sub")).FullName;
        Assert.Equal(plain, AgentRules.ProjectOf(plain));
        Assert.Null(AgentRules.Read(null, claude, managed: false).File);
        Assert.Null(AgentRules.ProjectOf(Path.Combine(_dir, "not-there")));
    }

    [Fact]
    public void A_folder_above_the_project_restricts_but_its_allows_dont_count()
    {
        var (claude, project) = Project(shared: """{ "allow": ["Bash(git:*)", "Bash(npm test:*)"] }""");
        // ~/.claude is also the project folder of ~, above this one: what its local file denies holds; what it allows isn't this project's.
        File.WriteAllText(Path.Combine(claude, "settings.local.json"), """{ "permissions": { "allow": ["Bash(docker:*)"], "deny": ["Bash(git * --force)"] } }""");
        var plan = AgentRules.Read(project, claude, managed: false);
        Assert.Equal(["Bash(git:*)", "Bash(npm test:*)", "Bash(git * --force)"], plan.Rules.Select(r => r.Text));
        Assert.Equal(["-", "npm test", "-"], Commands(plan.Rules));
    }

    [Fact]
    public void A_settings_file_that_cant_be_relied_on_keeps_every_allow_behind()
    {
        var (claude, project) = Project(user: """{ "allow": ["Bash(git:*)"], "deny": ["Bash(rm -rf:*)"] }""");
        var shared = Path.Combine(project, ".claude", "settings.json");

        // Broken: it may hold a deny nobody can read now.
        File.WriteAllText(shared, "{ not json");
        var broken = AgentRules.Read(project, claude, managed: false);
        Assert.Equal(["-", "rm -rf"], Commands(broken.Rules));
        Assert.Contains("couldn't be read", broken.Rules[0].Why);

        // Too large to read, with a deny inside that would have restricted the allow.
        File.WriteAllText(shared, """{ "permissions": { "deny": ["Bash(git push:*)"] } }""" + new string(' ', (int)AgentRules.MaxSettingsBytes));
        var large = AgentRules.Read(project, claude, managed: false);
        Assert.Equal(["-", "rm -rf"], Commands(large.Rules));
        Assert.Contains("too large", large.Rules[0].Why);

        // More rules than are looked at: the deny at the end mustn't be lost while the allow goes through.
        var many = string.Join(',', Enumerable.Range(0, AgentRules.MaxRules + 50).Select(i => $"\"Bash(tool{i}:*)\""));
        File.WriteAllText(shared, $$"""{ "permissions": { "allow": [{{many}}], "deny": ["Bash(git push:*)"] } }""");
        var crowded = AgentRules.Read(project, claude, managed: false);
        Assert.DoesNotContain(crowded.Rules, r => r.Decision == Allow && r.Prefix is not null);
        Assert.Contains("too many", crowded.Rules[0].Why);
    }

    [Fact]
    public void Managed_settings_keep_every_allow_behind()
    {
        var (claude, project) = Project(user: """{ "allow": ["Bash(git:*)"], "deny": ["Bash(rm -rf:*)"] }""");
        // An organization's own restrictions can't all be read from here, so nothing is allowed past them.
        var managed = AgentRules.Read(project, claude, managed: true);
        Assert.Equal(["-", "rm -rf"], Commands(managed.Rules));
        Assert.Contains("organization", managed.Rules[0].Why);
        // A file that says only the organization's rules count does the same.
        File.WriteAllText(Path.Combine(project, ".claude", "settings.json"), """{ "allowManagedPermissionRulesOnly": true, "permissions": { "allow": ["Bash(npm test:*)"] } }""");
        Assert.Equal(["-", "rm -rf", "-"], Commands(AgentRules.Read(project, claude, managed: false).Rules));
    }

    [Fact]
    public void A_rules_line_quotes_its_words_and_carries_termillys_mark()
    {
        Assert.Equal("""prefix_rule(pattern=["git", "diff"], decision="allow")""" + AgentRulesFile.Mark, AgentRulesFile.Line(["git", "diff"], Allow));
        // Words never hold these (they stay behind), but a line can't be broken by one all the same.
        Assert.Equal("""prefix_rule(pattern=["a\\b", "say \"hi\"", "x\x0ay"], decision="prompt")""" + AgentRulesFile.Mark, AgentRulesFile.Line(["a\\b", "say \"hi\"", "x\ny"], Prompt));
    }

    [Fact]
    public void Copying_writes_termillys_lines_anew_and_leaves_every_other_line_as_it_was()
    {
        var first = AgentRulesFile.Merge(null, Rules("""{ "allow": ["Bash(git:*)", "Read(**)"] }"""));
        Assert.StartsWith("#", first);
        Assert.Equal(1, AgentRulesFile.Count(first));

        // The user adds a rule of their own, reformatted and commented: not Termilly's, so it stays to the letter.
        var mine = "prefix_rule( pattern = [\"kubectl\", \"delete\"],\n    decision = \"forbidden\" )  # mine\n# keep this";
        var edited = first + mine;

        // Claude Code now denies forced pushes in a way Codex can't express: the git allow copied before must go.
        var second = AgentRulesFile.Merge(edited, Rules("""{ "allow": ["Bash(git:*)", "Bash(npm test:*)"], "deny": ["Bash(git * --force)", "Bash(git push:*)"] }"""));
        Assert.DoesNotContain("""pattern=["git"], decision="allow""", second);
        Assert.Contains(mine, second);
        Assert.EndsWith("# keep this\n" + AgentRulesFile.Line(["npm", "test"], Allow) + "\n" + AgentRulesFile.Line(["git", "push"], Forbidden) + "\n", second);
        Assert.Equal(2, AgentRulesFile.Count(second));

        // The same rules again change nothing; none at all leaves only what's the user's.
        Assert.Equal(second, AgentRulesFile.Merge(second, Rules("""{ "allow": ["Bash(npm test:*)"], "deny": ["Bash(git push:*)"] }""")));
        Assert.Equal(0, AgentRulesFile.Count(AgentRulesFile.Merge(second, [])));
        Assert.Contains(mine, AgentRulesFile.Merge(second, []));
    }

    [Fact]
    public void A_line_like_termillys_inside_the_users_own_text_isnt_taken_for_a_rule_already_there()
    {
        // The same rule as text the user wrote, without the mark: Termilly still writes its own line, so the deny is in force.
        var existing = "note = \"\"\"\nprefix_rule(pattern=[\"git\", \"push\"], decision=\"forbidden\")\n\"\"\"\n";
        var merged = AgentRulesFile.Merge(existing, Rules("""{ "allow": ["Bash(git:*)"], "deny": ["Bash(git push:*)"] }"""));
        Assert.StartsWith(existing, merged);
        Assert.Contains(AgentRulesFile.Line(["git", "push"], Forbidden), merged);
    }

    [Fact]
    public void The_file_is_written_whole_in_the_projects_codex_folder()
    {
        var path = AgentRulesFile.PathIn(Path.Combine(_dir, "repo"));
        Assert.Equal(1, AgentRulesFile.Write(Rules("""{ "allow": ["Bash(git diff:*)"] }"""), path));
        Assert.Equal(2, AgentRulesFile.Write(Rules("""{ "allow": ["Bash(git diff:*)"], "deny": ["Bash(git push:*)"] }"""), path));
        Assert.EndsWith(Path.Combine("repo", ".codex", "rules", "termilly.rules"), path);
        Assert.Equal([AgentRulesFile.Line(["git", "diff"], Allow), AgentRulesFile.Line(["git", "push"], Forbidden)],
            File.ReadAllLines(path).Where(l => l.StartsWith("prefix_rule", StringComparison.Ordinal)));
        Assert.Single(Directory.GetFiles(Path.GetDirectoryName(path)!)); // no temporary file left beside it
    }

    [Fact]
    public void Only_exactly_what_the_user_was_shown_is_copied()
    {
        var carried = Rules("""{ "allow": ["Bash(git diff:*)"], "deny": ["Bash(git push:*)"] }""").Where(r => r.Prefix is not null).ToList();
        var shown = new List<AgentRuleChoice> { new("Bash(git diff:*)", Allow, "git diff"), new("Bash(git push:*)", Forbidden, "git push") };
        Assert.True(AgentRulesHandler.SameAsShown(carried, shown));
        // A rule added since, one gone since, or one that means something else now: nothing is copied.
        Assert.False(AgentRulesHandler.SameAsShown(carried, shown.Take(1).ToList()));
        Assert.False(AgentRulesHandler.SameAsShown(carried.Take(1).ToList(), shown));
        Assert.False(AgentRulesHandler.SameAsShown(carried, [shown[0], shown[1] with { Decision = Allow }]));
        Assert.False(AgentRulesHandler.SameAsShown(carried, [shown[0] with { Command = "git" }, shown[1]]));
    }
}
