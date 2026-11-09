// @ts-check
// The coding agents Termilly knows (Claude Code, Codex). A new agent added here gets what they have: its badge on the
// terminal while it runs (ui.js, its mark there), its name in the spinner's and the badge's words, and its resume
// command. The host knows it by the same id (AgentKinds in ../Shared/AgentLookup.cs).

import { AGENT_KIND, PROFILE_ICON } from './constants.js';

/**
 * @typedef {object} AgentKind
 * @property {string} name the product's name: Claude Code
 * @property {string} short what the spinner's words call it: Claude
 * @property {string} icon its badge (PROFILE_ICON; ui.js draws its mark)
 * @property {string} program the command that starts it, which is its program's name too
 * @property {(session: string) => string} resume what resumes one of its sessions
 */

/** @type {Readonly<Record<string, AgentKind>>} */
export const AGENTS = Object.freeze({
  [AGENT_KIND.claude]: {
    name: AGENT_KIND.claudeName, short: 'Claude', icon: PROFILE_ICON.claude, program: AGENT_KIND.claude,
    resume: session => `claude --resume ${session}`,
  },
  [AGENT_KIND.codex]: {
    name: AGENT_KIND.codexName, short: AGENT_KIND.codexName, icon: PROFILE_ICON.codex, program: AGENT_KIND.codex,
    resume: session => `codex resume ${session}`,
  },
});

/**
 * An agent by its id; Claude Code when it isn't said (or isn't one Termilly knows).
 * @param {string | null | undefined} kind
 */
export const agentKind = kind => AGENTS[kind ?? ''] ?? AGENTS[AGENT_KIND.claude];

/**
 * Which agent a program is (codex.exe, claude), or null: what the host saw running in a terminal (tab.interactive).
 * @param {string | null | undefined} program
 */
export function agentOfProgram(program) {
  const name = (program ?? '').toLowerCase().replace(/\.exe$/, '');
  return Object.keys(AGENTS).find(kind => AGENTS[kind].program === name) ?? null;
}

/** The agents' commands, for a pattern that sees a command line start one. */
export const AGENT_PROGRAMS = Object.values(AGENTS).map(a => a.program);
