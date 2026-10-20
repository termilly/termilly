using System.Text;
using Termilly.Agent;

// One helper, three jobs, picked by the name it runs under:
//   claude.exe                          the shim: starts the real Claude Code with Termilly's hooks (Shim.cs)
//   termilly.exe ...                    the termilly command and its MCP server (Cli.cs, Mcp.cs)
//   termilly-hook.exe hook 1 <Event>    a Claude Code hook: tells Termilly the pane's agent event
//   termilly-hook.exe statusline 1      Claude Code's status line: passes the plan limits on, then runs the user's own (StatusLine.cs)
//   termilly-hook.exe selftest          checks this terminal can reach Termilly, and which claude it would run

CrashLog.Install(CrashLog.HelperFileName);
var name = Path.GetFileNameWithoutExtension(Environment.ProcessPath);
if (string.Equals(name, AgentExecutables.Claude, StringComparison.OrdinalIgnoreCase))
{
    return Shim.Run(args);
}
if (string.Equals(name, AgentExecutables.Cli, StringComparison.OrdinalIgnoreCase))
{
    return Cli.Run(args);
}
if (string.Equals(name, AgentExecutables.Askpass, StringComparison.OrdinalIgnoreCase))
{
    return Askpass.Run(args);
}

return args switch
{
    [HookCommands.Hook, var version, var hookEvent] => Hook(version, hookEvent),
    [HookCommands.StatusLine, var version] => StatusLine.Run(version, Console.OpenStandardInput(), Console.Out),
    ["selftest"] => SelfTest(),
    _ => Usage(),
};

// A hook must never get in the agent's way: it prints nothing (some events read stdout as instructions), always
// exits 0, and gives up after a second if Termilly doesn't answer.
static int Hook(string version, string hookEvent)
{
    var pane = Environment.GetEnvironmentVariable(Protocol.PaneVariable);
    var pipe = Environment.GetEnvironmentVariable(Protocol.PipeVariable);
    if (version != Protocol.Version.ToString() || string.IsNullOrEmpty(pane) || string.IsNullOrEmpty(pipe))
    {
        return 0;
    }

    string? payload = null;
    try
    {
        payload = ReadPayload(Console.OpenStandardInput(), Protocol.MaxEditChars + ReadChunk);
    }
    catch (IOException)
    {
        // No payload: the event alone still counts.
    }

#if DEBUG
    // Development only: TERMILLY_HOOK_LOG names a file that gets every raw payload, to see what Claude Code sends.
    if (Environment.GetEnvironmentVariable(HookLogVariable) is { Length: > 0 } log)
    {
        try { File.AppendAllText(log, $"{DateTime.Now:HH:mm:ss.fff}\t{hookEvent}\t{payload}\n"); } catch (IOException) { }
    }
#endif
    var reply = Protocol.Send(pipe, Protocol.Message(pane, hookEvent, payload), PipeTimeouts.Hook);
#if DEBUG
    if (Environment.GetEnvironmentVariable(HookLogVariable) is { Length: > 0 } replyLog)
    {
        try { File.AppendAllText(replyLog, $"{DateTime.Now:HH:mm:ss.fff}\treply\t{reply ?? "(none)"} pane={pane} pipe={pipe}\n"); } catch (IOException) { }
    }
#endif
    // In its "full edit" change-preview mode the app asks for the edit itself; the hook doesn't know the setting.
    if (hookEvent == HookEvents.PostToolUse && reply?.Contains(HookReplies.SendEditMark) == true)
    {
        Protocol.Send(pipe, Protocol.EditMessage(pane, payload), PipeTimeouts.Edit);
    }
    return 0;
}

// Reads stdin in chunks up to a limit. A payload cut off at the limit isn't valid JSON, so it's dropped and the
// event is reported without it.
static string? ReadPayload(Stream input, int maxChars)
{
    using var stdin = new StreamReader(input, Encoding.UTF8);
    var text = new StringBuilder();
    var buffer = new char[ReadChunk];
    int read;
    while ((read = stdin.Read(buffer, 0, buffer.Length)) > 0)
    {
        if (text.Length + read > maxChars)
        {
            return null;
        }
        text.Append(buffer, 0, read);
    }
    return text.ToString();
}

static int SelfTest()
{
    var pane = Environment.GetEnvironmentVariable(Protocol.PaneVariable);
    var pipe = Environment.GetEnvironmentVariable(Protocol.PipeVariable);
    var settings = Environment.GetEnvironmentVariable(Protocol.SettingsVariable);
    var ok = true;

    void Check(bool passed, string what, string detail)
    {
        ok &= passed;
        Console.WriteLine($"{(passed ? "ok  " : "FAIL")}  {what}: {detail}");
    }

    Console.WriteLine($"Termilly agent integration, hook v{Protocol.Version}");
    Check(!string.IsNullOrEmpty(pane), "terminal id", pane ?? "not set (is this a Termilly terminal?)");
    Check(File.Exists(settings), "hook settings", settings ?? "not set (agent integration is off in Settings)");
    var reply = string.IsNullOrEmpty(pipe) || string.IsNullOrEmpty(pane)
        ? null
        : Protocol.Send(pipe, Protocol.Message(pane, "SelfTest", null), SelfTestTimeout);
    Check(reply?.Contains(HookReplies.OkMark) == true, Product.Name, reply is null ? "didn't answer" : "answered");
    var real = Shim.FindReal(Environment.GetEnvironmentVariable(SystemVariables.Path), Environment.GetEnvironmentVariable(SystemVariables.PathExt), AppContext.BaseDirectory);
    Check(real is not null, "Claude Code", real ?? "not found on PATH");
    return ok ? 0 : 1;
}

static int Usage()
{
    Console.Error.WriteLine("usage: termilly-hook selftest");
    return 2;
}

/// <summary>The helper's own numbers.</summary>
internal static partial class Program
{
    /// <summary>How much of a hook's input is read at a time (and how far past an edit's limit a payload may go).</summary>
    private const int ReadChunk = 64 << 10;
    private static readonly TimeSpan SelfTestTimeout = TimeSpan.FromSeconds(2);
    /// <summary>Development builds: a file that gets every raw payload, to see what Claude Code sends.</summary>
    private const string HookLogVariable = "TERMILLY_HOOK_LOG";
}
