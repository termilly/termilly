using System.IO;
using System.Text;
using Termilly.Desktop.Features;
using Termilly.Desktop.Messaging;

namespace Termilly.Desktop.Tests;

/// <summary>The compact view's lines (Features/CompactFeed.cs and its readers): a session's file as one line per step.</summary>
public sealed class CompactFeedTests : IDisposable
{
    private const string Cwd = "D:\\\\work\\\\app";
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-compact-" + Guid.NewGuid().ToString("N"));

    public CompactFeedTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static List<CompactLine> Lines(ICompactReader reader, params string[] lines)
    {
        var log = new CompactLog();
        foreach (var line in lines)
        {
            reader.Read(Encoding.UTF8.GetBytes(line), log);
        }
        return log.All().ToList();
    }

    private static string User(string uuid, string content, string extra = "") =>
        $$$"""{"type":"user"{{{extra}}},"uuid":"{{{uuid}}}","cwd":"{{{Cwd}}}","message":{"role":"user","content":{{{content}}}}}""";

    private static string Assistant(string uuid, string blocks, string extra = "") =>
        $$$"""{"type":"assistant"{{{extra}}},"uuid":"{{{uuid}}}","cwd":"{{{Cwd}}}","message":{"role":"assistant","content":[{{{blocks}}}]}}""";

    private static string Result(string uuid, string id, string details, string content = "\"ok\"", bool error = false) =>
        $$"""{"type":"user","uuid":"{{uuid}}","cwd":"{{Cwd}}","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"{{id}}","content":{{content}},"is_error":{{(error ? "true" : "false")}}}]},"toolUseResult":{{details}}}""";

    [Fact]
    public void A_claude_turn_reads_as_prompt_words_tools_with_their_results_and_its_end()
    {
        var lines = Lines(new CompactClaude(),
            User("u1", "\"Make the notes scroll.\""),
            Assistant("a1", """{"type":"thinking","thinking":""},{"type":"text","text":"Checking the layout first."}"""),
            Assistant("a2", """{"type":"tool_use","id":"t1","name":"Grep","input":{"pattern":"ReasonMax","path":"D:\\work\\app\\src"}}"""),
            Result("r1", "t1", """{"mode":"content","numLines":12,"numFiles":0}"""),
            Assistant("a3", """{"type":"tool_use","id":"t2","name":"Read","input":{"file_path":"D:\\work\\app\\src\\Update.cs"}}"""),
            Result("r2", "t2", """{"type":"text","file":{"filePath":"x","numLines":412}}"""),
            Assistant("a4", """{"type":"tool_use","id":"t3","name":"Edit","input":{"file_path":"D:\\work\\app\\update.css"}}"""),
            Result("r3", "t3", """{"structuredPatch":[{"lines":[" a","-b","+c","+d"]}]}"""),
            Assistant("a5", """{"type":"tool_use","id":"t4","name":"Bash","input":{"command":"dotnet test --filter Update"}}"""),
            Result("r4", "t4", """{"stdout":"Passed!  - Failed: 0, Passed: 23, Skipped: 0","interrupted":false}"""),
            """{"type":"system","subtype":"turn_duration","durationMs":134000,"uuid":"s1"}""");

        Assert.Equal(
            [
                (CompactKinds.Prompt, null, "Make the notes scroll.", null),
                (CompactKinds.Reply, null, "Checking the layout first.", null),
                (CompactKinds.Tool, CompactVerbs.Search, "\"ReasonMax\" in src", "12 hits"),
                (CompactKinds.Tool, CompactVerbs.Read, "src/Update.cs", "412 lines"),
                (CompactKinds.Tool, CompactVerbs.Edit, "update.css", "+2 -1"),
                (CompactKinds.Tool, CompactVerbs.Test, "dotnet test --filter Update", "23 passed"),
                (CompactKinds.End, null, "", "2m 14s"),
            ],
            lines.Select(l => (l.Kind, l.Verb, l.Text, l.Detail)));
    }

    [Fact]
    public void A_claude_tool_runs_until_its_result_and_a_failure_says_why()
    {
        var log = new CompactLog();
        var reader = new CompactClaude();
        reader.Read(Encoding.UTF8.GetBytes(Assistant("a1", """{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"npm run check"}}""")), log);
        Assert.False(log.Find("t1")!.Done);

        reader.Read(Encoding.UTF8.GetBytes(Result("r1", "t1", "\"Error: Exit code 1\\nlint failed\"", "\"Exit code 1\\nlint failed\"", error: true)), log);
        var line = log.Find("t1")!;
        Assert.Equal((true, true, "Exit code 1"), (line.Done, line.Failed, line.Detail));
    }

    [Fact]
    public void Claude_bookkeeping_subagents_and_slash_commands_are_handled()
    {
        var lines = Lines(new CompactClaude(),
            User("u1", "\"Caveat: hidden\"", ",\"isMeta\":true"),
            Assistant("a1", """{"type":"text","text":"from a subagent"}""", ",\"isSidechain\":true"),
            User("u2", "\"<command-name>/model</command-name>\\n<command-message>model</command-message>\""),
            User("u3", "\"<local-command-stdout>Set model</local-command-stdout>\""),
            User("u4", """[{"type":"text","text":"[Request interrupted by user]"}]"""),
            Assistant("a2", """{"type":"tool_use","id":"t1","name":"mcp__termilly__list_tasks","input":{}}"""));

        Assert.Equal(
            [(CompactKinds.Prompt, "/model"), (CompactKinds.Interrupted, ""), (CompactKinds.Tool, "termilly: list_tasks")],
            lines.Select(l => (l.Kind, l.Text)));
    }

    [Fact]
    public void A_claude_question_carries_its_choices_for_the_card_and_its_answers_once_given()
    {
        var log = new CompactLog();
        var reader = new CompactClaude();
        reader.Read(Encoding.UTF8.GetBytes(Assistant("a1", """{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[{"question":"Tabs or spaces?","header":"Indent","multiSelect":false,"options":[{"label":"Tabs","description":"Tab characters."},{"label":"Spaces"}]}]}}""")), log);
        var asked = log.Find("q1")!;
        Assert.Equal((CompactVerbs.Ask, "Tabs or spaces?", false), (asked.Verb, asked.Text, asked.Done));
        var question = Assert.Single(asked.Questions!);
        Assert.Equal(("Indent", false), (question.Header, question.Multi));
        Assert.Equal([new CompactOption("Tabs", "Tab characters."), new CompactOption("Spaces", null)], question.Options);

        reader.Read(Encoding.UTF8.GetBytes(Result("r1", "q1", """{"questions":[],"answers":{"Tabs or spaces?":"Spaces"}}""")), log);
        Assert.Equal((true, "Spaces"), (log.Find("q1")!.Done, log.Find("q1")!.Detail));
    }

    [Fact]
    public void A_plan_up_for_approval_carries_the_plan_from_the_file_claude_wrote_it_to()
    {
        var plans = Directory.CreateDirectory(Path.Combine(_dir, ".claude", "plans")).FullName;
        var plan = Path.Combine(plans, "short-plan.md");
        File.WriteAllText(plan, "# Plan\n\n- Append Done. to hello.txt\n");
        var json = System.Text.Json.JsonSerializer.Serialize(plan);
        var lines = Lines(new CompactClaude(),
            Assistant("a1", $$$"""{"type":"tool_use","id":"w1","name":"Write","input":{"file_path":{{{json}}},"content":"x"}}"""),
            Assistant("a2", """{"type":"tool_use","id":"p1","name":"ExitPlanMode","input":{}}"""));

        var asked = lines.Single(l => l.Key == "p1");
        Assert.Equal((CompactVerbs.Plan, "# Plan\n\n- Append Done. to hello.txt"), (asked.Verb, asked.Body));
        Assert.Null(lines.Single(l => l.Key == "w1").Body);
    }

    private static string Item(string item) =>
        $$$"""{"timestamp":"2026-11-13T18:11:37.093Z","type":"event_msg","payload":{"type":"item_completed","item":{{{item}}}}}""";

    [Fact]
    public void A_codex_turn_sorts_its_commands_and_counts_its_changes()
    {
        var lines = Lines(new CompactCodex(),
            """{"type":"session_meta","payload":{"id":"s","cwd":"D:\\work\\app"}}""",
            Item("""{"type":"UserMessage","id":"m1","content":[{"type":"text","text":"Fix the flaky test."}]}"""),
            Item("""{"type":"Reasoning","id":"r1","summary_text":["Looking for clock use."]}"""),
            Item("""{"type":"CommandExecution","id":"c1","parsed_cmd":[{"type":"search","cmd":"rg -n NextRun tests","query":"NextRun","path":"tests"}],"aggregated_output":"a\nb\nc\n","exit_code":0}"""),
            Item("""{"type":"CommandExecution","id":"c2","parsed_cmd":[{"type":"read","cmd":"Get-Content x","name":"ScheduleTests.cs","path":"D:/work/app/tests/ScheduleTests.cs"}],"aggregated_output":"1\n2\n","exit_code":0}"""),
            Item("""{"type":"FileChange","id":"f1","changes":{"D:\\work\\app\\tests\\ScheduleTests.cs":{"type":"update","unified_diff":"--- a\n+++ b\n@@\n-x\n+y\n+z\n"}},"status":"completed"}"""),
            Item("""{"type":"CommandExecution","id":"c3","parsed_cmd":[{"type":"unknown","cmd":"dotnet test --filter Schedule"}],"aggregated_output":"Failed: 1, Passed: 40","exit_code":1}"""),
            Item("""{"type":"AgentMessage","id":"m2","content":[{"type":"Text","text":"Moved it onto the fake clock."}]}"""),
            """{"type":"event_msg","payload":{"type":"task_complete","turn_id":"t1","duration_ms":91000}}""");

        Assert.Equal(
            [
                (CompactKinds.Prompt, null, "Fix the flaky test.", null, false),
                (CompactKinds.Thinking, null, "Looking for clock use.", null, false),
                (CompactKinds.Tool, CompactVerbs.Search, "\"NextRun\" in tests", "3 hits", false),
                (CompactKinds.Tool, CompactVerbs.Read, "tests/ScheduleTests.cs", "2 lines", false),
                (CompactKinds.Tool, CompactVerbs.Edit, "tests/ScheduleTests.cs", "+2 -1", false),
                (CompactKinds.Tool, CompactVerbs.Test, "dotnet test --filter Schedule", "1 failed · 40 passed", true),
                (CompactKinds.Reply, null, "Moved it onto the fake clock.", null, false),
                (CompactKinds.End, null, "", "1m 31s", false),
            ],
            lines.Select(l => (l.Kind, l.Verb, l.Text, l.Detail, l.Failed)));
    }

    [Fact]
    public void A_view_gets_every_line_when_switched_on_then_only_what_changed()
    {
        var path = Path.Combine(_dir, "s.jsonl");
        File.WriteAllText(path, User("u1", "\"First\"") + "\n");
        var sent = new List<ToPage.CompactLines>();
        using var feed = new CompactFeed(sent.Add, (_, _) => path);

        feed.Watch(new FromPage.CompactWatch("pane", "session-1", "claude"));
        feed.Tick();
        File.AppendAllText(path, Assistant("a1", """{"type":"text","text":"Second"}""") + "\n");
        feed.Tick();
        feed.Tick(); // nothing new: nothing sent
        feed.Watch(new FromPage.CompactWatch("pane", "session-1", "claude")); // switched on again
        feed.Tick();

        Assert.Equal(
            [(true, "First"), (false, "Second"), (true, "First|Second")],
            sent.Select(m => (m.Reset, string.Join("|", m.Lines.Select(l => l.Text)))));
        Assert.All(sent, m => Assert.Equal(("pane", "session-1"), (m.Id, m.Session)));
    }

    [Fact]
    public void A_session_whose_file_isnt_written_yet_starts_empty_and_is_looked_for_again()
    {
        var path = Path.Combine(_dir, "later.jsonl");
        var sent = new List<ToPage.CompactLines>();
        using var feed = new CompactFeed(sent.Add, (_, _) => File.Exists(path) ? path : null);

        feed.Watch(new FromPage.CompactWatch("pane", "session-2", "codex"));
        feed.Tick();
        File.WriteAllText(path, Item("""{"type":"UserMessage","id":"m1","content":[{"type":"text","text":"Hi"}]}""") + "\n");
        for (var i = 0; i < 4; i++)
        {
            feed.Tick();
        }

        Assert.Equal([(true, 0), (false, 1)], sent.Select(m => (m.Reset, m.Lines.Count)));
        feed.Watch(new FromPage.CompactWatch("pane"));
        feed.Tick();
        Assert.Equal(2, sent.Count);
    }

    [Theory]
    [InlineData("Passed!  - Failed:     0, Passed:    23, Skipped:     0", "23 passed")]
    [InlineData("# pass 41\n# fail 2", "2 failed · 41 passed")]
    [InlineData("Tests: 3 failed, 12 passed, 15 total", "3 failed · 12 passed")]
    [InlineData("nothing here", null)]
    public void A_test_runs_output_gives_its_counts(string output, string? expected) =>
        Assert.Equal(expected, CompactText.TestResult(output));
}
