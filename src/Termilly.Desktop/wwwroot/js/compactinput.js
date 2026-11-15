// @ts-check
// The compact view's prompt box (js/compact.js): Enter sends what's in it. With nothing in it, the keys an agent's
// own screen answers go to the agent: Esc (stop, back), Shift+Tab (its mode), Up and Down (its menus, its history)
// and Enter (pick). "/" at the start lists the agent's commands, and "@" offers the files of its folder, in a list
// above the box: Up and Down move in it, Enter or Tab takes one, Esc closes it.

import { PAGE } from './protocol.js';
import { request } from './host.js';
import { escapeHtml } from './ui.js';
import { find } from './dom.js';
import { AGENT_KIND } from './constants.js';

/** The keys that go to the agent from an empty box, as its terminal would get them. */
const PASS_KEYS = Object.freeze({ Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', Enter: '\r' });
/** Shift+Tab, as a terminal sends it. */
const BACK_TAB = '\x1b[Z';
/** The word being typed at the caret: a command at the box's start, or a file after an @. */
const COMMAND_WORD = /^\/(\S*)$/;
const FILE_WORD = /(^|\s)@(\S*)$/;
/** A file search waits this long after the last key. */
const FILE_DELAY_MS = 150;
/** What the word at the caret is: a command, or a file. */
const WORD = Object.freeze({ command: 'command', file: 'file' });
/** The list's item the keys are on. */
const ON = 'on';
/** The list shows at most this many. */
const MAX_SHOWN = 12;

/**
 * Each agent's own commands, as its "/" list offers them (the ones a box can start; any other can still be typed).
 * @type {Readonly<Record<string, ReadonlyArray<[string, string]>>>}
 */
const COMMANDS = Object.freeze({
  [AGENT_KIND.claude]: [
    ['/model', 'Pick the model'], ['/clear', 'Start a new conversation'], ['/compact', 'Summarise the conversation to free context'],
    ['/resume', 'Go back to an earlier conversation'], ['/context', 'What fills the context'], ['/usage', 'Plan limits used'],
    ['/status', 'Version, model and account'], ['/config', 'Settings'], ['/permissions', 'What it may do without asking'],
    ['/agents', 'Subagents'], ['/mcp', 'MCP servers'], ['/memory', 'Edit its memory files'], ['/hooks', 'Hooks'],
    ['/init', 'Write a CLAUDE.md for this project'], ['/review', 'Review a pull request'], ['/help', 'Help'],
  ],
  [AGENT_KIND.codex]: [
    ['/model', 'Pick the model and reasoning effort'], ['/new', 'Start a new conversation'], ['/compact', 'Summarise the conversation to free context'],
    ['/resume', 'Go back to an earlier conversation'], ['/permissions', 'What it may do without asking'], ['/status', 'Session settings and limits'],
    ['/diff', 'Show the changes, untracked files too'], ['/review', 'Review the changes'], ['/mention', 'Mention a file'],
    ['/init', 'Write an AGENTS.md for this project'],
  ],
});

/**
 * @typedef {{ value: string, label: string, detail: string }} Pick
 * @typedef {{ tab: Tab, input: HTMLTextAreaElement, list: HTMLElement, picks: Pick[], at: number,
 *   word: { kind: string, start: number } | null, timer: number, asked: number }} InputState
 * @typedef {{ submit: () => void, passKey: (data: string) => void, agent: () => string | null, folder: () => string | null }} InputHooks
 */

/**
 * Wires the prompt box of a compact view: its keys, and its list of commands and files.
 * @param {Tab} tab
 * @param {HTMLElement} el the view
 * @param {InputHooks} hooks
 */
export function wireInput(tab, el, hooks) {
  const input = /** @type {HTMLTextAreaElement} */ (find(el, '.cv-input'));
  /** @type {InputState} */
  const s = { tab, input, list: find(el, '.cv-picks'), picks: [], at: 0, word: null, timer: 0, asked: 0 };
  input.addEventListener('keydown', e => onKey(s, e, hooks));
  input.addEventListener('input', () => findWord(s, hooks));
  // A click in the list moves the focus about (the pane gives its terminal the focus, which hands it back to the box):
  // the list closes only if the box is left for good.
  input.addEventListener('blur', () => setTimeout(() => { if (input.ownerDocument.activeElement !== input) close(s); }));
  s.list.addEventListener('mousedown', e => {
    const item = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest('[data-pick]'));
    if (!item) return;
    e.preventDefault(); // the box keeps the focus
    take(s, Number(item.dataset.pick));
  });
}

/**
 * @param {InputState} s
 * @param {KeyboardEvent} e
 * @param {InputHooks} hooks
 */
function onKey(s, e, hooks) {
  if (e.isComposing) return;
  if (s.picks.length && listKey(s, e)) {
    e.preventDefault();
    return;
  }
  const empty = !s.input.value;
  if (e.key === 'Tab' && e.shiftKey && empty) {
    e.preventDefault();
    hooks.passKey(BACK_TAB);
  } else if (empty && !e.shiftKey && !e.ctrlKey && !e.altKey && e.key in PASS_KEYS) {
    e.preventDefault();
    hooks.passKey(/** @type {Record<string, string>} */ (PASS_KEYS)[e.key]);
  } else if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    hooks.submit();
  }
}

/**
 * The list's own keys while it shows: true when the key was its.
 * @param {InputState} s
 * @param {KeyboardEvent} e
 */
function listKey(s, e) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    s.at = (s.at + (e.key === 'ArrowDown' ? 1 : -1) + s.picks.length) % s.picks.length;
    draw(s);
  } else if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') take(s, s.at);
  else if (e.key === 'Escape') close(s);
  else return false;
  return true;
}

/**
 * The word at the caret: a command or a file to offer, or none (the list closes).
 * @param {InputState} s
 * @param {InputHooks} hooks
 */
function findWord(s, hooks) {
  const before = s.input.value.slice(0, s.input.selectionStart ?? s.input.value.length);
  const command = COMMAND_WORD.exec(before);
  const file = FILE_WORD.exec(before);
  clearTimeout(s.timer);
  if (command) {
    s.word = { kind: WORD.command, start: 0 };
    const typed = `/${command[1]}`.toLowerCase();
    show(s, (COMMANDS[hooks.agent() ?? ''] ?? []).filter(([name]) => name.startsWith(typed)).map(([name, detail]) => ({ value: name, label: name, detail })));
  } else if (file && hooks.folder()) {
    s.word = { kind: WORD.file, start: before.length - file[2].length - 1 };
    // What was found for the word before it changed is no answer to it: gone at once, and any answer still to come.
    s.asked++;
    show(s, []);
    s.timer = window.setTimeout(() => findFiles(s, /** @type {string} */ (hooks.folder()), file[2]), FILE_DELAY_MS);
  } else close(s);
}

/**
 * Asks the host for the files that match; an answer to an older question is dropped.
 * @param {InputState} s
 * @param {string} dir
 * @param {string} text
 */
async function findFiles(s, dir, text) {
  const asked = ++s.asked;
  const m = await request(PAGE.compactFiles, { dir, text });
  if (asked !== s.asked || s.word?.kind !== WORD.file) return;
  show(s, (m.paths ?? []).map((/** @type {string} */ path) => ({ value: `@${path}`, label: path, detail: '' })));
}

/**
 * @param {InputState} s
 * @param {Pick[]} picks
 */
function show(s, picks) {
  s.picks = picks.slice(0, MAX_SHOWN);
  s.at = 0;
  draw(s);
}

/** @param {InputState} s */
function draw(s) {
  s.list.hidden = !s.picks.length;
  s.list.innerHTML = s.picks.map((p, i) => `<div class="cv-pick${i === s.at ? ` ${ON}` : ''}" data-pick="${i}">`
    + `<span>${escapeHtml(p.label)}</span>${p.detail ? `<small>${escapeHtml(p.detail)}</small>` : ''}</div>`).join('');
  s.list.querySelector(`.${ON}`)?.scrollIntoView({ block: 'nearest' });
}

/** @param {InputState} s */
function close(s) {
  clearTimeout(s.timer);
  s.asked++;
  s.word = null;
  show(s, []);
}

/**
 * Puts a pick in the box in place of the word it was for, with a space after it.
 * @param {InputState} s
 * @param {number} i
 */
function take(s, i) {
  const pick = s.picks[i];
  const word = s.word;
  if (!pick || !word) return;
  const value = s.input.value;
  const caret = s.input.selectionStart ?? value.length;
  const text = `${pick.value} `;
  s.input.value = value.slice(0, word.start) + text + value.slice(caret);
  s.input.setSelectionRange(word.start + text.length, word.start + text.length);
  close(s);
  s.input.dispatchEvent(new Event('input')); // the box fits its text
}
