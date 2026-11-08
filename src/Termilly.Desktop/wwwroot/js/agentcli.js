// @ts-check
// Claude Code's command line, for runs with nobody watching (js/schedules.js): how one is asked, and what its answer says.

import { PROFILE_ICON } from './constants.js';
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
/** Everything is allowed: where nobody can be asked (on a server), and To do's Allow all in Silent runs is on. */
const EVERYTHING = Object.freeze(['--permission-mode', 'bypassPermissions']);

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
 * @param {{ shell?: string, changes?: boolean, all?: boolean, json?: boolean, ask?: boolean }} options json: the answer comes as
 *   one result, to read; else as text, for a terminal someone may look at. ask: what it may not do it asks the user, through the
 *   host. all: with changes, it may do anything without asking.
 */
export function agentCommand(prompt, { shell, changes = false, all = false, json = false, ask = false }) {
  const allowed = changes ? (all ? EVERYTHING : CHANGES) : READ_ONLY;
  const words = [AGENT_COMMAND, '--print', promptFor(prompt, shell, !json), ...(json ? ['--output-format', 'json'] : []), ...allowed, ...ALWAYS, ...(ask ? [] : NOBODY_ASKS)];
  return commandLine(words, shell);
}

/**
 * A word for what a run was refused.
 * @param {{ tool_name?: string }[]} denied
 */
function wanted(denied) {
  const names = [...new Set(denied.map(d => d.tool_name ?? 'a tool'))];
  return `It needed permission for ${names.slice(0, MAX_NAMED).join(', ')}${names.length > MAX_NAMED ? ` and ${names.length - MAX_NAMED} more` : ''}.`;
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
 * What a run's output says, when it's Claude Code's result: its reply, whether it failed, and why. Null for anything else: a shell
 * that couldn't find it, or an older one on a server.
 * @param {string} output as text
 * @returns {{ reply: string, failed: boolean, errored: boolean, why: string, costUsd: number | null } | null} failed: it ended
 *   with an error or was refused a tool; errored: only the first.
 */
export function readResult(output) {
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
