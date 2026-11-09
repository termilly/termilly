// @ts-check
// An agent's command line, for runs with nobody watching (js/schedules.js, js/todorun.js): how Claude Code or Codex is asked,
// and what its answer says.

import { PROFILE_ICON, AGENT_KIND } from './constants.js';
import { commandLine } from './quoting.js';

/** What runs Claude Code. */
export const AGENT_COMMAND = 'claude';
/** What a read only run has. Nothing here changes a file or runs a command. */
const READ_TOOLS = 'Read,Grep,Glob,WebFetch,WebSearch';
/** Of those, the ones that would ask first: there's nobody to ask. */
const READ_TOOLS_ALLOWED = 'WebFetch,WebSearch';
/** How many of the tools a run was refused are named. */
const MAX_NAMED = 3;
/** The first lines of a reply, for a notification. */
const NOTICE_CHARS = 280;

/** Every run: nothing keeps a session, and no MCP server can act for it (one that asks the user is added by the host). */
const ALWAYS = Object.freeze(['--strict-mcp-config', '--no-session-persistence']);
/** A run nobody is asked in: what would ask is refused. One that asks gets its way of asking from the host (AskingRun.cs). */
const NOBODY_ASKS = Object.freeze(['--permission-prompts', 'none']);
/**
 * Read only leaves the user's settings out (--restricted), as their allow rules can let commands run, and gives it only tools
 * that read. Keeping it to that list is what makes it read only: refusing at a prompt wouldn't be enough.
 */
const READ_ONLY = Object.freeze(['--restricted', '--tools', READ_TOOLS, '--allowedTools', READ_TOOLS_ALLOWED]);
/** Changes are allowed: files are edited without asking, and commands run as the user's own settings say. */
const CHANGES = Object.freeze(['--permission-mode', 'acceptEdits']);
/**
 * Changes are allowed with nobody to ask: Claude Code's auto mode, as in a session, where a safety check lets safe commands
 * run and refuses risky ones. The user's settings still allow what they allow.
 */
const CHANGES_UNASKED = Object.freeze(['--permission-mode', 'auto']);
/** Everything is allowed: where nobody can be asked (on a server), and To do's Allow all in Silent runs is on. */
const EVERYTHING = Object.freeze(['--permission-mode', 'bypassPermissions']);
/**
 * A review of another agent's work: the tools that read, and git's commands that only show (what changed is in git diff).
 * Anything else it tries is refused, as nobody is asked.
 */
const REVIEW = Object.freeze(['--restricted', '--tools', `${READ_TOOLS},Bash`, '--allowedTools',
  `${READ_TOOLS_ALLOWED},Bash(git status:*),Bash(git diff:*),Bash(git log:*),Bash(git show:*)`]);

/** Codex without a terminal: its events as JSON lines, in any folder. */
const CODEX_RUN = Object.freeze([AGENT_KIND.codex, 'exec', '--json', '--skip-git-repo-check']);
/** Codex's sandboxes: reading only (a prompt that may not change files, a review), or writing in its folder. */
const CODEX_READ_ONLY = Object.freeze(['--sandbox', 'read-only']);
const CODEX_CHANGES = Object.freeze(['--sandbox', 'workspace-write']);
/** Everything is allowed, as Claude Code's EVERYTHING. */
const CODEX_EVERYTHING = Object.freeze(['--dangerously-bypass-approvals-and-sandbox']);
/** What stands in for a percent sign in a prompt for Codex (codexPrompt). */
const WIDE_PERCENT = '\uFF05';

/**
 * A prompt as Codex can be handed it. On Windows Codex is npm's codex.cmd, so cmd reads its command line: that ends at the first
 * line break (the rest of a prompt was lost), a double quote inside it ends the quoting, after which an & would run as a command,
 * and %NAME% is filled in. So the prompt goes on one line, with no double quote and no percent sign in it. Another agent's reply
 * is part of a review's prompt, so what's in it isn't ours to choose.
 * @param {string} prompt
 */
const codexPrompt = prompt => prompt.trim().replace(/\s*\r?\n\s*/g, ' ').replaceAll('"', "'").replaceAll('%', WIDE_PERCENT);

/**
 * A prompt as a shell can pass it on. Windows PowerShell 5.1 breaks a program's argument at a double quote inside it, and
 * cmd runs each line by itself, as a shell at its prompt would.
 * @param {string} prompt
 * @param {string} [shell] a profile's icon
 * @param {boolean} [typed] it's typed at a prompt
 */
function promptFor(prompt, shell, typed) {
  const text = prompt.trim();
  const oneLine = shell === PROFILE_ICON.cmd || typed ? text.replace(/\s*\r?\n\s*/g, ' ') : text;
  return shell === PROFILE_ICON.powerShell ? oneLine.replaceAll('"', "'") : oneLine;
}

/**
 * The command for a prompt.
 * @param {string} prompt
 * @param {{ kind?: string, shell?: string, changes?: boolean, all?: boolean, json?: boolean, ask?: boolean, review?: boolean }} options
 *   kind: the agent (AGENT_KIND), Claude Code when not said. json: the answer comes as one result, to read; else as text, for a
 *   terminal someone may look at. ask: what it may not do it asks the user, through the host (Claude Code only). all: with
 *   changes, it may do anything without asking. review: it reads and looks at what changed, and changes nothing.
 */
export function agentCommand(prompt, { kind = AGENT_KIND.claude, shell, changes = false, all = false, json = false, ask = false, review = false }) {
  if (kind === AGENT_KIND.codex) {
    // Codex without a terminal asks nobody: its sandbox is what it may do. Its answer is always JSON lines.
    const sandbox = review || !changes ? CODEX_READ_ONLY : all ? CODEX_EVERYTHING : CODEX_CHANGES;
    return commandLine([...CODEX_RUN, ...sandbox, codexPrompt(prompt)], shell);
  }
  const allowed = review ? REVIEW : !changes ? READ_ONLY : all ? EVERYTHING : ask ? CHANGES : CHANGES_UNASKED;
  const words = [AGENT_COMMAND, '--print', promptFor(prompt, shell, !json), ...(json ? ['--output-format', 'json'] : []), ...allowed, ...ALWAYS, ...(ask ? [] : NOBODY_ASKS)];
  return commandLine(words, shell);
}

/**
 * A word for what a run was refused.
 * @param {{ tool_name?: string }[]} denied
 */
function wanted(denied) {
  const names = [...new Set(denied.map(d => d.tool_name ?? 'a tool'))];
  return `Refused ${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ''}.`;
}

/**
 * The start of a reply, for a notification.
 * @param {string} reply
 */
export function noticeOf(reply) {
  const text = reply.trim();
  return text.length > NOTICE_CHARS ? `${text.slice(0, NOTICE_CHARS - 1).trimEnd()}…` : text;
}

/**
 * @typedef {{ reply: string, failed: boolean, errored: boolean, why: string, costUsd: number | null }} AgentResult failed: it
 *   ended with an error or was refused a tool; errored: only the first.
 */

/** Codex's events (its JSON lines) that say how a run went. */
const CODEX_EVENT = Object.freeze({ item: 'item.completed', message: 'agent_message', done: 'turn.completed', failed: 'turn.failed', error: 'error' });

/**
 * What Codex's run says: its last message as the reply, and whether its turn failed. Null when it printed no events: a shell
 * that couldn't find it.
 * @param {string} output as text
 * @returns {AgentResult | null}
 */
function readCodex(output) {
  /** @type {any[]} */
  const events = [];
  for (const line of output.split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{"type"')) continue;
    try {
      events.push(JSON.parse(text));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  if (!events.length) return null;
  const reply = events.findLast(e => e.type === CODEX_EVENT.item && e.item?.type === CODEX_EVENT.message)?.item.text ?? '';
  const error = events.findLast(e => e.type === CODEX_EVENT.failed || e.type === CODEX_EVENT.error);
  const errored = !!error && !events.some(e => e.type === CODEX_EVENT.done);
  const why = errored ? String(error.error?.message ?? error.message ?? 'It ended with an error.') : '';
  return { reply: String(reply), failed: errored, errored, why, costUsd: null };
}

/**
 * What a run's output says, when it's the agent's result: its reply, whether it failed, and why. Null for anything else: a shell
 * that couldn't find it, or an older one on a server.
 * @param {string} output as text
 * @param {string} [kind] the agent (AGENT_KIND), Claude Code when not said
 * @returns {AgentResult | null}
 */
export function readResult(output, kind = AGENT_KIND.claude) {
  if (kind === AGENT_KIND.codex) return readCodex(output);
  const start = output.lastIndexOf('{"');
  const whole = output.indexOf('{"');
  for (const at of [whole, start]) {
    if (at < 0) continue;
    try {
      const result = JSON.parse(output.slice(at).trim());
      if (result?.type !== 'result') continue;
      const denied = Array.isArray(result.permission_denials) ? result.permission_denials : [];
      const errors = Array.isArray(result.errors) ? result.errors.join(' ') : '';
      const why = denied.length ? wanted(denied) : result.is_error ? errors || String(result.subtype ?? 'It ended with an error.') : '';
      return { reply: String(result.result ?? ''), failed: !!result.is_error || denied.length > 0, errored: !!result.is_error, why, costUsd: typeof result.total_cost_usd === 'number' ? result.total_cost_usd : null };
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return null;
}
