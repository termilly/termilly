extern alias agent;

using System.IO;
using System.Text.Json.Nodes;
using agent::Termilly.Agent;

namespace Termilly.Desktop.Tests;

public sealed class AgentHooksTests : IDisposable
{
    private readonly string _dir = Path.Combine(Path.GetTempPath(), "termilly-tests", Guid.NewGuid().ToString("N"));

    public AgentHooksTests() => Directory.CreateDirectory(_dir);

    public void Dispose() => Directory.Delete(_dir, recursive: true);

    private static AgentEvent Event(string name, string? tool = null) => new("pane-1", name, null, tool, null, null);

    // ---- What events mean ----

    [Theory]
    [InlineData("SessionStart", "idle")]
    [InlineData("UserPromptSubmit", "working")]
    [InlineData("PreToolUse", "working")]
    [InlineData("PostToolUse", "working")]
    [InlineData("PreCompact", "working")]
    [InlineData("PermissionRequest", "needs-input")]
    [InlineData("Stop", "done")]
    [InlineData("StopFailure", "error")]
    [InlineData("SessionEnd", "exited")]
    [InlineData("Notification", null)]
    [InlineData("SelfTest", null)]
    public void Events_map_to_pane_states(string hookEvent, string? state) =>
        Assert.Equal(state, AgentHooks.StateFor(Event(hookEvent)));

    [Fact]
    public void Claude_asking_a_question_needs_the_user() =>
        Assert.Equal("needs-input", AgentHooks.StateFor(Event("PreToolUse", "AskUserQuestion")));

    // ---- The hooks Termilly adds to Claude Code ----

    [Fact]
    public void Claude_settings_run_the_helper_for_every_event_with_forward_slashes()
    {
        var path = Path.Combine(_dir, "claude-settings.json");
        ClaudeHookSettings.Write(path, @"C:\Program Files\Termilly\agent\termilly-hook.exe");

        var hooks = JsonNode.Parse(File.ReadAllText(path))!["hooks"]!.AsObject();
        Assert.Contains("PermissionRequest", hooks.Select(h => h.Key));
        Assert.Contains("StopFailure", hooks.Select(h => h.Key));
        foreach (var (name, entries) in hooks)
        {
            var hook = entries![0]!["hooks"]![0]!;
            Assert.Equal($"\"C:/Program Files/Termilly/agent/termilly-hook.exe\" hook {AgentHooks.Version} {name}", hook["command"]!.GetValue<string>());
            Assert.Equal("command", hook["type"]!.GetValue<string>());
        }
        Assert.Equal("*", hooks["PreToolUse"]![0]!["matcher"]!.GetValue<string>());
        Assert.Null(hooks["Stop"]![0]!["matcher"]);
    }

    [Fact]
    public void Helper_and_app_agree_on_the_protocol()
    {
        Assert.Equal(Protocol.Version, AgentHooks.Version);
        var vars = SessionLaunch.WithAgent(new Dictionary<string, string>(), "p", "pipe", "s.json", @"C:\app\agent");
        Assert.Equal("p", vars[Protocol.PaneVariable]);
        Assert.Equal("pipe", vars[Protocol.PipeVariable]);
        Assert.Equal("s.json", vars[Protocol.SettingsVariable]);
        Assert.Equal("", vars[Protocol.ShimVariable]); // empty removes an inherited one
    }

    // ---- The status line (plan limits) ----

    [Fact]
    public void The_status_line_is_added_only_when_asked_and_keeps_the_users_padding()
    {
        var path = Path.Combine(_dir, "claude-settings.json");
        ClaudeHookSettings.Write(path, @"C:\app\agent\termilly-hook.exe");
        Assert.Null(JsonNode.Parse(File.ReadAllText(path))!["statusLine"]);

        var user = Path.Combine(_dir, "settings.json");
        File.WriteAllText(user, """{ "statusLine": { "type": "command", "command": "~/.claude/line.sh", "padding": 2, "refreshInterval": 10 } }""");
        ClaudeHookSettings.Write(path, @"C:\app\agent\termilly-hook.exe", statusLine: true, userSettings: user);
        var line = JsonNode.Parse(File.ReadAllText(path))!["statusLine"]!;
        Assert.Equal($"\"C:/app/agent/termilly-hook.exe\" statusline {AgentHooks.Version}", line["command"]!.GetValue<string>());
        Assert.Equal((2, 10), (line["padding"]!.GetValue<int>(), line["refreshInterval"]!.GetValue<int>()));
    }

    [Fact]
    public void Only_the_plan_limits_leave_the_status_line()
    {
        const string input = """
            { "session_id": "s1", "transcript_path": "C:/secret/t.jsonl", "workspace": { "current_dir": "D:/work" },
              "cost": { "total_cost_usd": 1.5 },
              "context_window": { "used_percentage": 24.6, "context_window_size": 200000, "total_input_tokens": 49200, "current_usage": { "input_tokens": 2 } },
              "rate_limits": { "five_hour": { "used_percentage": 23.5, "resets_at": 1760180000 }, "seven_day": { "used_percentage": 140 } } }
            """;
        var line = StatusLine.Message("p1", input);
        Assert.DoesNotContain("secret", line);
        Assert.DoesNotContain("work", line);
        var e = AgentHooks.Parse(line)!;
        Assert.Equal(("p1", "StatusLine", "s1"), (e.Pane, e.Event, e.Session));
        Assert.Equal(new PlanWindow(23.5, 1760180000), e.Status!.Limits!.FiveHour);
        Assert.Equal(new PlanWindow(100, null), e.Status.Limits.SevenDay);
        Assert.Equal(new ContextFigures(24.6, 200_000, 49_200), e.Status.Context);
        Assert.Null(AgentHooks.StateFor(e));
    }

    [Fact]
    public void Without_a_subscription_or_an_older_claude_there_are_no_figures()
    {
        var e = AgentHooks.Parse(StatusLine.Message("p1", """{ "session_id": "s1" }"""))!;
        Assert.Equal(new PlanLimits(null, null), e.Status!.Limits);
        Assert.Null(e.Status.Context);
    }

    [Fact]
    public void The_users_status_line_is_found_project_first_and_never_termillys()
    {
        var home = Directory.CreateDirectory(Path.Combine(_dir, "home")).FullName;
        var project = Directory.CreateDirectory(Path.Combine(_dir, "project", ".claude")).Parent!.FullName;
        var input = $$"""{ "workspace": { "project_dir": {{System.Text.Json.JsonSerializer.Serialize(project)}} } }""";
        Assert.Null(StatusLine.UserCommand(input, home));

        File.WriteAllText(Path.Combine(home, "settings.json"), """{ "statusLine": { "type": "command", "command": "user-line" } }""");
        Assert.Equal("user-line", StatusLine.UserCommand(input, home));
        File.WriteAllText(Path.Combine(project, ".claude", "settings.json"), """{ "statusLine": { "type": "command", "command": "project-line" } }""");
        Assert.Equal("project-line", StatusLine.UserCommand(input, home));
        File.WriteAllText(Path.Combine(project, ".claude", "settings.local.json"), """{ "statusLine": { "command": "\"C:/app/agent/termilly-hook.exe\" statusline 1" } }""");
        Assert.Null(StatusLine.UserCommand(input, home));
    }

    [Fact]
    public void The_plan_is_read_without_the_account_details()
    {
        var plan = ClaudePlan.Parse("""{ "loggedIn": true, "authMethod": "claude.ai", "email": "a@b.c", "orgName": "Org", "subscriptionType": "max" }""");
        Assert.Equal(new ClaudePlan.Info("max", "claude.ai"), plan);
    }

    // ---- What reaches the app ----

    [Fact]
    public void Subagents_pass_their_id_type_and_description_never_the_prompt()
    {
        // As captured from Claude Code 2.1.296 (research_notes/claude-subagent-hooks.md).
        var call = """
            {"session_id":"s","tool_name":"Agent","tool_use_id":"toolu_1",
             "tool_input":{"description":"List txt files","prompt":"my secret plan","subagent_type":"Explore","run_in_background":true},
             "tool_response":{"isAsync":true,"status":"async_launched","agentId":"a8e1","prompt":"my secret plan"}}
            """;
        var launched = AgentHooks.Parse(Protocol.Message("p", "PostToolUse", call))!;
        Assert.Equal(new Subagent(null, null, "toolu_1", "List txt files", "Explore", true, "a8e1"), launched.Subagent);
        Assert.DoesNotContain("secret", Protocol.Message("p", "PostToolUse", call));

        var inside = """{"session_id":"s","agent_id":"a8e1","agent_type":"Explore","tool_name":"Glob","tool_input":{"pattern":"*.txt"}}""";
        var tool = AgentHooks.Parse(Protocol.Message("p", "PreToolUse", inside))!;
        Assert.Equal(("a8e1", "Explore"), (tool.Subagent!.AgentId, tool.Subagent.AgentType));

        var stop = """{"session_id":"s","agent_id":"a8e1","agent_type":"Explore","last_assistant_message":"a.txt","agent_transcript_path":"C:/t.jsonl"}""";
        var stopped = AgentHooks.Parse(Protocol.Message("p", "SubagentStop", stop))!;
        Assert.Equal("a.txt", stopped.Message);
        Assert.Null(AgentHooks.StateFor(stopped)); // a subagent finishing doesn't make the terminal look done

        // The main conversation's own events have no subagent.
        Assert.Null(AgentHooks.Parse(Protocol.Message("p", "Stop", """{"session_id":"s","last_assistant_message":"DONE"}"""))!.Subagent);
    }

    [Theory]
    [InlineData("Bash", """{"command":"npm test -- --token=abc123"}""", "npm")]
    [InlineData("PowerShell", """{"command":"  Get-ChildItem; Remove-Item secret.txt"}""", "Get-ChildItem")]
    [InlineData("Grep", """{"pattern":"refreshToken","path":"src"}""", "refreshToken")]
    [InlineData("Read", """{"file_path":"C:/p/src/a.ts"}""", "C:/p/src/a.ts")]
    [InlineData("Agent", """{"subagent_type":"Explore","prompt":"find my secret"}""", "Explore")]
    [InlineData("WebFetch", """{"url":"https://example.com/?key=1"}""", null)]
    public void The_activity_line_gets_a_few_words_never_the_input(string tool, string input, string? target)
    {
        var payload = $$"""{"session_id":"abc","tool_name":"{{tool}}","tool_input":{{input}}}""";

        var e = AgentHooks.Parse(Protocol.Message("pane-1", "PreToolUse", payload))!;

        Assert.Equal(target, e.Target);
        Assert.DoesNotContain("abc123", Protocol.Message("pane-1", "PreToolUse", payload));
        Assert.DoesNotContain("secret", Protocol.Message("pane-1", "PreToolUse", payload));
    }

    [Fact]
    public void Messages_carry_only_what_termilly_shows()
    {
        var payload = """
            {"session_id":"abc","hook_event_name":"Stop","prompt":"my secret prompt","transcript_path":"C:/t.jsonl",
             "last_assistant_message":"All tests pass.","tool_input":{"command":"rm -rf /"}}
            """;
        var e = AgentHooks.Parse(Protocol.Message("pane-1", "Stop", payload))!;

        Assert.Equal(new AgentEvent("pane-1", "Stop", "abc", null, "All tests pass.", null), e);
        Assert.DoesNotContain("secret", Protocol.Message("pane-1", "Stop", payload));
        Assert.DoesNotContain("rm -rf", Protocol.Message("pane-1", "Stop", payload));

        // An edit tool passes the path of its file and the folder, and still nothing of the edit itself.
        var edit = """
            {"session_id":"abc","tool_name":"Edit","cwd":"C:/p","prompt":"my secret prompt",
             "tool_input":{"file_path":"C:/p/a.ts","old_string":"my secret","new_string":"new text"}}
            """;
        foreach (var hookEvent in new[] { "PreToolUse", "PostToolUse" })
        {
            var message = Protocol.Message("pane-1", hookEvent, edit);
            var parsed = AgentHooks.Parse(message)!;
            Assert.Equal(("C:/p/a.ts", "C:/p", "Edit"), (parsed.File, parsed.Cwd, parsed.Tool));
            Assert.DoesNotContain("secret", message);
            Assert.DoesNotContain("new text", message);
        }
        Assert.Null(AgentHooks.Parse(Protocol.Message("pane-1", "PermissionRequest", edit))!.File);
    }

    [Fact]
    public void Session_start_names_the_folder_the_session_resumes_in()
    {
        var payload = """{"session_id":"abc","cwd":"D:/Development/termilly","source":"startup"}""";
        Assert.Equal("D:/Development/termilly", AgentHooks.Parse(Protocol.Message("pane-1", "SessionStart", payload))!.Folder);
        Assert.Null(AgentHooks.Parse(Protocol.Message("pane-1", "Stop", payload))!.Folder);
    }

    [Theory]
    [InlineData("Bash")]
    [InlineData("PowerShell")]
    public void Shell_commands_pass_only_folders_and_the_program_never_the_command(string tool)
    {
        var payload = $$$"""{"tool_name":"{{{tool}}}","cwd":"C:/work","tool_input":{"command":"Copy-Item D:/temp/a.ps1 D:/temp/secret.ps1 -Verbose","file_path":"D:/temp/a.ps1"}}""";
        var message = Protocol.Message("p", "PreToolUse", payload);
        var e = AgentHooks.Parse(message)!;
        Assert.Equal((null, "C:/work", tool), (e.File, e.Cwd, e.Tool));
        Assert.Equal(["D:/temp"], e.Dirs!); // the folder the command names, nothing else from it
        Assert.DoesNotContain("a.ps1", message);
        Assert.DoesNotContain("secret", message);
        // Only the program it runs, for the activity line (js/agentline.js): never its arguments.
        Assert.Equal("Copy-Item", e.Target);
        Assert.DoesNotContain("Verbose", message);
    }

    [Fact]
    public void A_command_names_folders_by_its_paths()
    {
        // The command from the bug report: Claude renaming variables with PowerShell, working in its home folder.
        Assert.Contains(@"d:\temp", Protocol.CommandFolders(
            @"$t = [IO.File]::ReadAllText('d:\temp\test.ps1') -replace '\.\\test\.ps1', '.\test_funny.ps1'; [IO.File]::WriteAllText('d:\temp\test_funny.ps1', $t)"));
        // From the third report: Bash moving to the folder first, then naming only the file.
        Assert.Equal(["/d/temp"], Protocol.CommandFolders(@"cd /d/temp && sed -i -e 's/\$allTheApps\b/$everyApp/g' -e 's/\$shy\b/$quiet/g' test.ps1"));
        Assert.Equal(["/d/temp"], Protocol.CommandFolders("cp /d/temp/test.ps1 /d/temp/test_funny2.ps1 && cmp /d/temp/test.ps1 /d/temp/test_funny2.ps1"));
        Assert.Equal([@"D:\proj", @"D:\proj/src/api"], Protocol.CommandFolders(@"Set-Location D:\proj; (Get-Content src/api/a.ts) -replace 'x','y' | Set-Content src/api/a.ts"));
        Assert.Equal(["src", "/c/work"], Protocol.CommandFolders("cp src/a.ts /c/work/b.ts"));
        Assert.Equal([@"C:\Users\me\Documents"], Protocol.CommandFolders(@"Get-ChildItem C:\Users\me\Documents"));
        Assert.Equal(["."], Protocol.CommandFolders("sed -i s/a/b/ notes.md"));
        Assert.Empty(Protocol.CommandFolders("$p.Length; git status"));
        // Linux: absolute paths, and a folder named up to a shell variable (sub$i is a folder under gen); {1..5} reads
        // as a file name, which gives Claude's own folder (".").
        Assert.Equal(["/tmp/proj/gen/sub", "."],
            Protocol.CommandFolders("mkdir -p /tmp/proj/gen/sub{1..5} && for i in 1 2; do echo x > /tmp/proj/gen/sub$i/file$i.txt; done"));
        Assert.Equal(["/home/me/proj/src"], Protocol.CommandFolders("sed -i s/a/b/ /home/me/proj/src/a.ts"));
        Assert.Empty(Protocol.CommandFolders("cmd /c dir")); // cmd's switch, not a folder
        Assert.Equal(Protocol.MaxFolders, Protocol.CommandFolders(string.Join(' ', Enumerable.Range(0, 30).Select(i => $"C:/d{i}/f.txt"))).Count);
    }

    [Theory]
    [InlineData("""{"tool_name":"Read","cwd":"C:/p","tool_input":{"file_path":"C:/p/a.ts"}}""")]
    [InlineData("""{"tool_name":"Grep","cwd":"C:/p","tool_input":{"path":"C:/p","pattern":"secret"}}""")]
    public void Only_edit_tools_report_their_file(string payload)
    {
        var message = Protocol.Message("p", "PostToolUse", payload);
        Assert.Null(AgentHooks.Parse(message)!.File);
        Assert.DoesNotContain("a.ts", message);
        Assert.DoesNotContain("secret", message);
        Assert.DoesNotContain("C:/p", message);
    }

    [Fact]
    public void Notebook_edits_report_the_notebook_path() =>
        Assert.Equal("C:/p/n.ipynb", AgentHooks.Parse(Protocol.Message("p", "PreToolUse",
            """{"tool_name":"NotebookEdit","tool_input":{"notebook_path":"C:/p/n.ipynb","new_source":"x = 1"}}"""))!.File);

    [Fact]
    public void A_path_too_long_to_pass_whole_is_left_out_rather_than_cut()
    {
        var path = "C:/" + new string('a', Protocol.MaxPath);
        Assert.Null(AgentHooks.Parse(Protocol.Message("p", "PostToolUse",
            $$$"""{"tool_name":"Write","tool_input":{"file_path":"{{{path}}}"}}"""))!.File);
    }

    [Fact]
    public void Edit_messages_carry_the_edit_only_when_built_for_it_and_are_capped()
    {
        var multi = """
            {"session_id":"s","tool_name":"MultiEdit","cwd":"C:/p",
             "tool_input":{"file_path":"C:/p/a.ts","edits":[{"old_string":"a","new_string":""},{"old_string":"b","new_string":"c","replace_all":true}]},
             "tool_response":{"originalFile":"a b b"}}
            """;
        var edit = AgentHooks.ParseEdit(Protocol.EditMessage("p", multi))!;
        Assert.Equal(("C:/p/a.ts", "C:/p", "MultiEdit", "a b b", false), (edit.File, edit.Cwd, edit.Tool, edit.Original, edit.Truncated));
        Assert.Equal([new EditReplace("a", "", false), new EditReplace("b", "c", true)], edit.Edits);

        var write = """{"tool_name":"Write","tool_input":{"file_path":"C:/p/big.txt","content":"0123456789"}}""";
        Assert.Equal("0123456789", AgentHooks.ParseEdit(Protocol.EditMessage("p", write))!.Content);
        var cut = AgentHooks.ParseEdit(Protocol.EditMessage("p", write, maxChars: 5))!;
        Assert.Equal((null, true), (cut.Content, cut.Truncated));

        // An ordinary event is not an edit message, and an edit message is not an ordinary event.
        Assert.Null(AgentHooks.ParseEdit(Protocol.Message("p", "PostToolUse", write)));
        Assert.Null(AgentHooks.ParseEdit(Protocol.EditMessage("p", """{"tool_name":"Bash","tool_input":{"command":"ls"}}""")));
    }

    [Fact]
    public void Cut_off_payloads_still_report_the_event() =>
        Assert.Equal(new AgentEvent("p", "PostToolUse", null, null, null, null),
            AgentHooks.Parse(Protocol.Message("p", "PostToolUse", """{"tool_name":"Edit","tool_input":{"file_path":"C:/p/a""")));

    [Fact]
    public void Long_messages_are_cut_and_bad_payloads_still_report_the_event()
    {
        var long_ = new string('x', 2000);
        var e = AgentHooks.Parse(Protocol.Message("p", "Notification", $$"""{"message":"{{long_}}"}"""))!;
        Assert.Equal(Protocol.MaxMessage + 1, e.Message!.Length);

        Assert.Equal(new AgentEvent("p", "Stop", null, null, null, null), AgentHooks.Parse(Protocol.Message("p", "Stop", "not json")));
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("""{"v":2,"pane":"p","event":"Stop"}""")]
    [InlineData("""{"v":"1","pane":"p","event":"Stop"}""")]
    [InlineData("""{"v":1,"event":"Stop"}""")]
    [InlineData("""{"v":1,"pane":"p","event":7}""")]
    [InlineData("[1]")]
    public void Anything_else_is_ignored(string? line) => Assert.Null(AgentHooks.Parse(line));

    [Fact]
    public async Task Events_go_through_the_pipe_and_unknown_panes_are_refused()
    {
        var received = new List<AgentEvent>();
        using var hooks = new AgentHooks(e =>
        {
            lock (received)
            {
                received.Add(e);
            }
            return e.Pane == "known";
        }, $"termilly-test-{Guid.NewGuid():N}");

        var ok = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.Message("known", "PermissionRequest", """{"tool_name":"Bash"}"""), TimeSpan.FromSeconds(5)));
        var refused = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.Message("other", "Stop", null), TimeSpan.FromSeconds(5)));

        Assert.Equal("""{"ok":true}""", ok);
        Assert.Equal("""{"ok":false}""", refused);
        lock (received)
        {
            Assert.Equal("Bash", received.Single(e => e.Pane == "known").Tool);
        }
    }

    [Fact]
    public async Task The_app_asks_for_the_edit_through_its_reply_and_gets_it()
    {
        var edits = new List<EditContent>();
        using var hooks = new AgentHooks(e => e.File is null ? HookReply.Ok : HookReply.SendEdit,
            $"termilly-test-{Guid.NewGuid():N}", edit: e => { lock (edits) { edits.Add(e); } });
        var payload = """{"tool_name":"Write","tool_input":{"file_path":"C:/p/a.txt","content":"hello"}}""";

        var reply = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.Message("p", "PostToolUse", payload), TimeSpan.FromSeconds(5)));
        var plain = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.Message("p", "Stop", null), TimeSpan.FromSeconds(5)));
        var sent = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.EditMessage("p", payload), TimeSpan.FromSeconds(5)));

        Assert.Equal("""{"ok":true,"send":"edit"}""", reply);
        Assert.Equal("""{"ok":true}""", plain);
        Assert.Equal("""{"ok":true}""", sent);
        lock (edits)
        {
            Assert.Equal("hello", edits.Single().Content);
        }
    }

    [Fact]
    public async Task Long_edit_lines_are_read_but_other_long_lines_are_refused()
    {
        var edits = new List<EditContent>();
        var events = 0;
        using var hooks = new AgentHooks(_ => { Interlocked.Increment(ref events); return HookReply.Ok; },
            $"termilly-test-{Guid.NewGuid():N}", edit: e => { lock (edits) { edits.Add(e); } });
        var big = new string('x', 2 << 20);
        var write = $$$"""{"tool_name":"Write","tool_input":{"file_path":"C:/p/a.txt","content":"{{{big}}}"}}""";

        var sent = await Task.Run(() => Protocol.Send(hooks.PipeName, Protocol.EditMessage("p", write), TimeSpan.FromSeconds(10)));
        var tooLong = await Task.Run(() => Protocol.Send(hooks.PipeName,
            Protocol.Message("p", "Notification", null).Replace("}", $",\"padding\":\"{new string('y', 100_000)}\"}}"), TimeSpan.FromSeconds(5)));

        Assert.Equal("""{"ok":true}""", sent);
        Assert.NotEqual("""{"ok":true}""", tooLong); // refused: the helper sees {"ok":false} or, still writing, nothing
        Assert.Equal(0, events);
        lock (edits)
        {
            Assert.Equal(big.Length, edits.Single().Content!.Length);
        }
    }

    [Fact]
    public void Without_termilly_the_helper_gives_up_quickly() =>
        Assert.Null(Protocol.Send($"termilly-test-{Guid.NewGuid():N}", "{}", TimeSpan.FromMilliseconds(300)));

    // ---- The claude shim ----

    [Fact]
    public void The_shim_finds_the_real_claude_after_itself()
    {
        var shim = Directory.CreateDirectory(Path.Combine(_dir, "agent")).FullName;
        var npm = Directory.CreateDirectory(Path.Combine(_dir, "npm")).FullName;
        var native = Directory.CreateDirectory(Path.Combine(_dir, "native")).FullName;
        File.WriteAllText(Path.Combine(shim, "claude.exe"), "");
        File.WriteAllText(Path.Combine(npm, "claude.cmd"), "");
        File.WriteAllText(Path.Combine(npm, "claude.ps1"), "");
        File.WriteAllText(Path.Combine(native, "claude.exe"), "");

        Assert.Equal(Path.Combine(npm, "claude.cmd"), Shim.FindReal($"{shim};{npm};{native}", ".COM;.EXE;.CMD", shim + "\\"));
        Assert.Equal(Path.Combine(native, "claude.exe"), Shim.FindReal($"\"{shim}\";;{native}", null, shim));
        Assert.Null(Shim.FindReal(shim, ".EXE", shim));
        Assert.Null(Shim.FindReal($"{shim};{npm}", ".PS1", shim)); // a script would need PowerShell
    }

    [Fact]
    public void Terminals_get_the_agent_folder_first_on_their_own_path()
    {
        var vars = SessionLaunch.WithAgent(
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase) { ["path"] = @"C:\tools" }, "p", "pipe", "s", @"C:\app\agent");
        Assert.Equal(@"C:\app\agent;C:\tools", vars["PATH"]);
    }
}
