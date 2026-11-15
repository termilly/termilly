// @ts-check
// What autocomplete suggests (autocomplete.js), worked out from the command history and the screen: no terminal or
// page here, so it can be tested on its own. A command run before ranks by where it ran (this folder, then this
// repository), how often and how lately, and whether it worked; words on the screen rank newest (lowest) first.

import { DAY_MS } from './util.js';

/** How a redacted secret is stored (SecretRedactor.Mask): such a command can't be typed back. */
const REDACTED = '[redacted]';
/** What a run in this folder, and in this repository, adds to a command's score. */
const HERE_BONUS = 8;
const REPO_BONUS = 3;
/** A command whose every run failed, or that ran only on other computers, drops this much. */
const FAILED_PENALTY = 4;
const ELSEWHERE_PENALTY = 2;
/** Recency: a day old counts half as much as just now. */
const HALF_LIFE_MS = DAY_MS;
/** A word on the screen this long or longer is offered (shorter ones are quicker typed). */
const MIN_WORD = 3;
/** Characters around words on the screen that aren't part of them (quotes, brackets, punctuation at the end). */
const WORD_EDGE = /^[\s"'`([{<]+|[\s"'`)\]}>,;:.!?]+$/g;

/**
 * A command from the history (CommandHistory.cs), as the host sends it.
 * @typedef {{ command: string, exitCode?: number | null, at: number, cwd?: string | null, host?: string | null }} RanCommand
 */

/**
 * Everything known about one command line: how often and when it ran, where, and whether it worked.
 * @typedef {{ command: string, count: number, lastAt: number, ok: boolean, lastFailed: boolean,
 *   folders: Map<string, number>, here: boolean }} Known
 */

/**
 * A suggestion: the command, its score, and what the list says about it.
 * @typedef {{ command: string, score: number, here: boolean, failed: boolean, count: number, at: number, elsewhere: boolean }} Suggestion
 */

/** @returns {Map<string, Known>} */
export const newIndex = () => new Map();

/**
 * Whether a command can be suggested: one line, nothing redacted in it.
 * @param {string | undefined} command
 * @returns {command is string}
 */
const suggestible = command => !!command && !command.includes('\n') && !command.includes(REDACTED) && !!command.trim();

/**
 * Adds one run to the index.
 * @param {Map<string, Known>} index
 * @param {RanCommand} run
 */
export function addRun(index, run) {
  const command = run.command?.trim();
  if (!suggestible(command)) return;
  const known = index.get(command) ?? { command, count: 0, lastAt: 0, ok: false, lastFailed: false, folders: new Map(), here: false };
  known.count++;
  const failed = !!run.exitCode;
  if (!failed) known.ok = true;
  if (run.at >= known.lastAt) {
    known.lastAt = run.at;
    known.lastFailed = failed;
  }
  if (!run.host) known.here = true;
  if (run.cwd) known.folders.set(run.cwd, (known.folders.get(run.cwd) ?? 0) + 1);
  index.set(command, known);
}

/**
 * An index of the runs (in any order).
 * @param {RanCommand[]} runs
 */
export function indexRuns(runs) {
  const index = newIndex();
  for (const run of runs) addRun(index, run);
  return index;
}

/**
 * The same folder, whatever the slashes and (on Windows) the case.
 * @param {string} path
 */
const folderKey = path => path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * @param {Known} known
 * @param {{ cwd?: string | null, root?: string | null, now: number }} where
 * @returns {Suggestion}
 */
function scored(known, { cwd, root, now }) {
  const folders = [...known.folders.keys()].map(folderKey);
  const here = !!cwd && folders.includes(folderKey(cwd));
  const repo = !!root && folders.some(f => f === folderKey(root) || f.startsWith(`${folderKey(root)}/`));
  const recency = 2 ** (-(now - known.lastAt) / HALF_LIFE_MS);
  const failed = !known.ok;
  const elsewhere = !known.here;
  const score = (here ? HERE_BONUS : repo ? REPO_BONUS : 0) + Math.log2(1 + known.count) + 2 * recency
    - (failed ? FAILED_PENALTY : known.lastFailed ? 1 : 0) - (elsewhere ? ELSEWHERE_PENALTY : 0);
  return { command: known.command, score, here, failed: known.lastFailed, count: known.count, at: known.lastAt, elsewhere };
}

/**
 * The commands for what's typed, best first: those that start with it (more than it), then, for the list, those
 * that have it elsewhere.
 * @param {Map<string, Known>} index
 * @param {string} typed
 * @param {{ cwd?: string | null, root?: string | null, now: number, limit: number, anywhere?: boolean }} options
 * @returns {Suggestion[]}
 */
export function suggest(index, typed, { limit, anywhere = false, ...where }) {
  const starts = [];
  const contains = [];
  const lower = typed.toLowerCase();
  for (const known of index.values()) {
    if (known.command === typed) continue;
    if (known.command.startsWith(typed)) starts.push(scored(known, where));
    else if (anywhere && typed.trim() && known.command.toLowerCase().includes(lower)) contains.push(scored(known, where));
  }
  const best = (/** @type {Suggestion} */ a, /** @type {Suggestion} */ b) => b.score - a.score || b.at - a.at;
  return [...starts.sort(best), ...contains.sort(best)].slice(0, limit);
}

/**
 * The best command to finish the line with (the grey text), or null.
 * @param {Map<string, Known>} index
 * @param {string} typed
 * @param {{ cwd?: string | null, root?: string | null, now: number }} where
 */
export function bestFor(index, typed, where) {
  if (!typed.trim()) return null;
  return suggest(index, typed, { ...where, limit: 1 })[0] ?? null;
}

/**
 * The next word of the rest of a suggestion (Ctrl+→): the spaces before it, the word, and the space after it.
 * @param {string} rest
 */
export function nextWord(rest) {
  return /^\s*[^\s/\\]*[/\\]?\s?/.exec(rest)?.[0] || rest;
}

/**
 * The word being typed: what's after the line's last space.
 * @param {string} typed
 */
export const partialWord = typed => /\S*$/.exec(typed)?.[0] ?? '';

/**
 * Words on the screen that start with the word being typed (more than it), newest (lowest on the screen) first.
 * @param {string[]} lines the screen's lines, top to bottom
 * @param {string} partial
 * @param {number} limit
 */
export function screenWords(lines, partial, limit) {
  const seen = new Set();
  const words = [];
  for (let i = lines.length - 1; i >= 0 && words.length < limit; i--) {
    for (const raw of lines[i].split(/\s+/).reverse()) {
      const word = raw.replace(WORD_EDGE, '');
      if (word.length < MIN_WORD || word === partial || !word.startsWith(partial) || seen.has(word) || !/[A-Za-z]/.test(word)) continue;
      seen.add(word);
      words.push(word);
      if (words.length >= limit) break;
    }
  }
  return words;
}
