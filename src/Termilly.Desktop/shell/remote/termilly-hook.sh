#!/bin/sh
# A Claude Code hook on a remote host (see termilly.sh): reports the event to Termilly on the other end of ssh as an
# escape sequence written to the terminal, since the pipe the local hook uses (Termilly.Agent) doesn't cross ssh.
#   termilly-hook.sh hook 1 <Event>
# Like the local hook it never gets in Claude's way: it prints nothing, always exits 0, and passes on only the few
# payload fields Termilly shows (the same as Protocol.Message), never prompts, tool input or file contents.

[ "$1" = hook ] && [ "$2" = 1 ] && [ -n "$3" ] || exit 0
event=$3

message=
if command -v python3 >/dev/null 2>&1; then
  message=$(python3 -c '
import json, sys

def text(o, k, n, cut=True):
    v = o.get(k) if isinstance(o, dict) else None
    if not isinstance(v, str) or not v:
        return None
    return v if len(v) <= n else (v[:n] + "…" if cut else None)

event = sys.argv[1]
try:
    p = json.load(sys.stdin)
except Exception:
    p = {}
if not isinstance(p, dict):
    p = {}
tool = text(p, "tool_name", 100)
inp = p.get("tool_input") if isinstance(p.get("tool_input"), dict) else {}
m = {
    "event": event,
    "session": text(p, "session_id", 100),
    "tool": tool,
    "message": text(p, "message", 500) or text(p, "last_assistant_message", 500),
    "reason": text(p, "reason", 100) or text(p, "error", 200),
}
agent = text(p, "agent_id", 100)
if agent:
    m["agentId"] = agent
    m["agentType"] = text(p, "agent_type", 100)
if event in ("PreToolUse", "PostToolUse") and tool in ("Agent", "Task"):
    resp = p.get("tool_response") if isinstance(p.get("tool_response"), dict) else {}
    m["toolUseId"] = text(p, "tool_use_id", 100)
    m["description"] = text(inp, "description", 100)
    m["subagentType"] = text(inp, "subagent_type", 100)
    m["background"] = inp.get("run_in_background") is True
    m["launchedId"] = text(resp, "agentId", 100)
if event == "PreToolUse":
    target = None
    if tool in ("Bash", "PowerShell"):
        words = (text(inp, "command", 2000) or "").split()
        target = words[0][:40] if words else None
    elif tool in ("Read", "NotebookRead"):
        target = text(inp, "file_path", 1000, False) or text(inp, "notebook_path", 1000, False)
    elif tool in ("Grep", "Glob"):
        target = text(inp, "pattern", 40)
    elif tool in ("Agent", "Task"):
        target = text(inp, "subagent_type", 60)
    if target:
        m["target"] = target
print(json.dumps({k: v for k, v in m.items() if v is not None}, separators=(",", ":")))
' "$event" 2>/dev/null)
fi
if [ -z "$message" ]; then
  # No python3: the event alone, as the local hook reports an unreadable payload.
  cat >/dev/null
  message="{\"event\":\"$event\"}"
fi

payload=$(printf '%s' "$message" | base64 | tr -d '\n')
# Claude Code runs hooks in a session of their own, without a terminal: the claude function (termilly.sh) passes its
# terminal's device in TERMILLY_TTY. Started some other way, the hook still tries its own terminal.
terminal=${TERMILLY_TTY:-/dev/tty}
[ -c "$terminal" ] || terminal=/dev/tty
# One write, so it can't land in the middle of Claude's own output. Inside tmux it goes through as passthrough
# (allow-passthrough on), and Termilly's tmux mode reads it from the pane's output either way.
if [ -n "$TMUX" ]; then
  { printf '\033Ptmux;\033\033]1337;TermillyHook=1;%s;%s\007\033\\' "$event" "$payload" >"$terminal"; } 2>/dev/null
else
  { printf '\033]1337;TermillyHook=1;%s;%s\007' "$event" "$payload" >"$terminal"; } 2>/dev/null
fi
exit 0
