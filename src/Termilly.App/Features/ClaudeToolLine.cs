using System.Text.Json.Nodes;
using Termilly.Desktop.Messaging;
using Termilly.Shared;

namespace Termilly.Desktop.Features;

/// <summary>
/// A Claude Code tool call as a compact line: its verb (Search, Read, Edit, Run, Test...), what it worked on, and from
/// its result (the transcript's toolUseResult, else the text Claude got back) what came of it.
/// </summary>
internal static class ClaudeToolLine
{
    private static class Input
    {
        public const string Command = "command";
        public const string FilePath = "file_path";
        public const string NotebookPath = "notebook_path";
        public const string Path = "path";
        public const string Pattern = "pattern";
        public const string Url = "url";
        public const string Query = "query";
        public const string Description = "description";
        public const string SubagentType = "subagent_type";
        public const string Questions = "questions";
        public const string Question = "question";
        public const string Todos = "todos";
        public const string Status = "status";
    }

    private static class Details
    {
        public const string File = "file";
        public const string NumLines = "numLines";
        public const string NumFiles = "numFiles";
        public const string Mode = "mode";
        public const string StructuredPatch = "structuredPatch";
        public const string Lines = "lines";
        public const string Type = "type";
        public const string Content = "content";
        public const string Stdout = "stdout";
        public const string Interrupted = "interrupted";
        public const string Code = "code";
        public const string Create = "create";
        public const string FilesMode = "files_with_matches";
        public const string Completed = "completed";
    }

    private const string McpSeparator = "__";
    /// <summary>An HTTP status from here on is an error.</summary>
    private const int HttpErrors = 400;

    /// <summary>
    /// A call as its line needs it until its result lands: not its whole input (a Write's file, an Edit's text), only
    /// what the line says and what its result is read with (a command, the to do list's progress).
    /// </summary>
    public static ClaudeCall Call(string name, JsonObject? input, string? cwd)
    {
        var (verb, subject) = Describe(name, input, cwd);
        var command = name is ClaudeTools.Bash or ClaudeTools.PowerShell ? input?[Input.Command].AsText() : null;
        return new ClaudeCall(name, verb, subject, command, name == ClaudeTools.TodoWrite ? TodoProgress(input) : null);
    }

    /// <summary>The verb and the subject: what kind of step, and what on.</summary>
    public static (string Verb, string Subject) Describe(string name, JsonObject? input, string? cwd)
    {
        string Text(string field) => input?[field].AsText() ?? "";
        string File(string field) => CompactText.Relative(Text(field), cwd);
        return name switch
        {
            ClaudeTools.Read or ClaudeTools.NotebookRead => (CompactVerbs.Read, File(Input.FilePath)),
            ClaudeTools.Grep => (CompactVerbs.Search, In($"\"{Text(Input.Pattern)}\"", File(Input.Path))),
            ClaudeTools.Glob => (CompactVerbs.List, In(Text(Input.Pattern), File(Input.Path))),
            ClaudeTools.Edit or ClaudeTools.MultiEdit => (CompactVerbs.Edit, File(Input.FilePath)),
            ClaudeTools.NotebookEdit => (CompactVerbs.Edit, File(Input.NotebookPath)),
            ClaudeTools.Write => (CompactVerbs.Write, File(Input.FilePath)),
            ClaudeTools.Bash or ClaudeTools.PowerShell => (CompactText.CommandVerb(Text(Input.Command)), CompactText.FirstLine(Text(Input.Command))),
            ClaudeTools.WebFetch => (CompactVerbs.Web, Text(Input.Url)),
            ClaudeTools.WebSearch => (CompactVerbs.Web, Text(Input.Query)),
            ClaudeTools.Agent or ClaudeTools.Task => (CompactVerbs.Agent, Subagent(Text(Input.SubagentType), Text(Input.Description))),
            ClaudeTools.TodoWrite => (CompactVerbs.Plan, "to do list"),
            ClaudeTools.ExitPlanMode => (CompactVerbs.Plan, "plan ready for you"),
            ClaudeTools.AskUserQuestion => (CompactVerbs.Ask, FirstQuestion(input)),
            _ when name.StartsWith(ClaudeTools.McpPrefix, StringComparison.Ordinal) => (CompactVerbs.Mcp, McpName(name)),
            _ => (CompactVerbs.Tool, name),
        };
    }

    /// <summary>The line once the tool's result is in (one that didn't fail).</summary>
    public static CompactLine Result(string id, ClaudeCall call, JsonObject? details, string output)
    {
        var verb = call.Verb;
        var detail = call.Name switch
        {
            ClaudeTools.Read or ClaudeTools.NotebookRead => details?[Details.File]?[Details.NumLines].AsLong() is { } n ? CompactText.LineCount(n) : null,
            ClaudeTools.Grep => SearchResult(details),
            ClaudeTools.Glob => details?[Details.NumFiles].AsLong() is { } files ? CompactText.FileCount(files) : null,
            ClaudeTools.Edit or ClaudeTools.MultiEdit or ClaudeTools.NotebookEdit => PatchResult(details),
            ClaudeTools.Write => WriteResult(details, ref verb),
            ClaudeTools.Bash or ClaudeTools.PowerShell => CommandResult(call.Command, details, output),
            ClaudeTools.WebFetch => details?[Details.Code].AsLong() is { } code and >= HttpErrors ? $"HTTP {code}" : "fetched",
            ClaudeTools.TodoWrite => call.Progress,
            _ => null,
        };
        return new CompactLine(id, CompactKinds.Tool, call.Subject, verb, detail ?? CompactText.Done);
    }

    private static string In(string what, string where) => string.IsNullOrEmpty(where) ? what : $"{what} in {where}";

    private static string Subagent(string type, string description) =>
        string.IsNullOrEmpty(type) ? description : string.IsNullOrEmpty(description) ? type : $"{type}: {description}";

    /// <summary>mcp__termilly__list_tasks reads "termilly: list_tasks".</summary>
    private static string McpName(string name)
    {
        var rest = name[ClaudeTools.McpPrefix.Length..];
        var split = rest.IndexOf(McpSeparator, StringComparison.Ordinal);
        return split < 0 ? rest : $"{rest[..split]}: {rest[(split + McpSeparator.Length)..]}";
    }

    private static string FirstQuestion(JsonObject? input) =>
        CompactText.FirstLine((input?[Input.Questions] as JsonArray)?.OfType<JsonObject>().FirstOrDefault()?[Input.Question].AsText());

    /// <summary>A search's hits (its matching lines), or the files it found.</summary>
    private static string? SearchResult(JsonObject? details)
    {
        if (details is null)
        {
            return null;
        }
        if (details[Details.Mode].AsText() == Details.FilesMode)
        {
            return details[Details.NumFiles].AsLong() is { } files ? CompactText.FileCount(files) : null;
        }
        return details[Details.NumLines].AsLong() is { } lines ? CompactText.HitCount(lines) : null;
    }

    /// <summary>An edit's added and removed lines, from the patch Claude Code keeps of it.</summary>
    private static string? PatchResult(JsonObject? details)
    {
        if (details?[Details.StructuredPatch] is not JsonArray hunks)
        {
            return null;
        }
        var (added, removed) = (0, 0);
        foreach (var line in hunks.OfType<JsonObject>().SelectMany(h => (h[Details.Lines] as JsonArray)?.Select(l => l.AsText()) ?? []))
        {
            if (line?.StartsWith('+') == true)
            {
                added++;
            }
            else if (line?.StartsWith('-') == true)
            {
                removed++;
            }
        }
        return CompactText.Changes(added, removed);
    }

    /// <summary>A new file's length ("new · 40 lines"), or an overwrite's changes (its verb becomes Edit).</summary>
    private static string? WriteResult(JsonObject? details, ref string verb)
    {
        if (details?[Details.Type].AsText() == Details.Create)
        {
            return $"new · {CompactText.LineCount(CompactText.Lines(details[Details.Content].AsText()))}";
        }
        verb = CompactVerbs.Edit;
        return PatchResult(details);
    }

    /// <summary>A command's output: a test run's counts, or how many lines it printed; "stopped" when the user stopped it.</summary>
    private static string CommandResult(string? command, JsonObject? details, string output)
    {
        if (details?[Details.Interrupted].AsBool() == true)
        {
            return "stopped";
        }
        return CompactText.Output(command ?? "", details?[Details.Stdout].AsText() ?? output);
    }

    /// <summary>The to do list's progress as Claude wrote it: "3 of 5".</summary>
    private static string? TodoProgress(JsonObject? input)
    {
        if (input?[Input.Todos] is not JsonArray todos || todos.Count == 0)
        {
            return null;
        }
        var done = todos.OfType<JsonObject>().Count(t => t[Input.Status].AsText() == Details.Completed);
        return $"{done} of {todos.Count}";
    }
}

/// <summary>A Claude Code tool call waiting for its result: its tool, its line's verb and subject, and what its result is read with.</summary>
internal sealed record ClaudeCall(string Name, string Verb, string Subject, string? Command, string? Progress);
