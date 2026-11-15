// @ts-check
// Autocomplete at a shell prompt, from the command history (suggest.js): the best command that starts with what's
// typed shows in grey after the cursor; → or End takes all of it, Ctrl+→ the next word, and typing on narrows it.
// Ctrl+Shift+Space (Settings › Keyboard) opens a list under the cursor: the commands that fit, best first, and words
// on the screen; ↑↓ pick, Tab or Enter puts it on the line (without running it), Esc closes it.
// Only at a prompt the shell marked (shell integration), on the normal screen (not vim's or an agent's), with the
// cursor at the end of the line, in the terminal being typed in. A shell that draws its own suggestion after the
// cursor (fish, zsh-autosuggestions, PowerShell 7's predictions) has text there, so this stays out of its way.

import { state, on, EVENTS } from './store.js';
import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import { addInputHook } from './terminals.js';
import { escapeHtml } from './ui.js';
import { find, XTERM_SCREEN } from './dom.js';
import { timeAgo } from './util.js';
import { repoAt, folderOfTab } from './reposnippets.js';
import { newIndex, indexRuns, addRun, bestFor, suggest, nextWord, partialWord, screenWords } from './suggest.js';

/** How many commands and screen words the list shows. */
const MAX_COMMANDS = 8;
const MAX_WORDS = 6;
/** Between the line and the list under it, in px. */
const GAP_PX = 4;
/** xterm's buffer while no full-screen program (vim, less, an agent) has the alternate one. */
const NORMAL_BUFFER = 'normal';
/** What the shell takes as Backspace (xterm sends it for the key). */
const BACKSPACE = '\x7f';
const KEY = Object.freeze({ right: 'ArrowRight', end: 'End', up: 'ArrowUp', down: 'ArrowDown', enter: 'Enter', tab: 'Tab', escape: 'Escape' });
/** What a row of the list puts on the line: a command from the history, or a word from the screen. */
const KIND = Object.freeze({ command: 'command', word: 'word' });

/**
 * A row of the list.
 * @typedef {{ kind: string, text: string, suggestion?: import('./suggest.js').Suggestion }} Item
 */

/** The command history, indexed once it's read; read again after it changed elsewhere (cleared, synced). */
const history = { index: newIndex(), loaded: false, asked: false };

/**
 * The grey text: the terminal it's in and the rest of the command it shows. The terminal typed in last is the one
 * that gets it.
 * @type {{ tab: Tab | null, rest: string, active: Tab | null }}
 */
const ghost = { tab: null, rest: '', active: null };
/** @type {WeakMap<Tab, HTMLElement>} */
const ghostEls = new WeakMap();

/** The list: its terminal (null while closed), its rows and the one picked. */
const list = { tab: /** @type {Tab | null} */ (null), items: /** @type {Item[]} */ ([]), index: 0 };
const listEl = document.createElement('div');
listEl.className = 'popover ac-list';
listEl.hidden = true;

let frame = 0;

const enabled = () => state.settings.terminal?.autocomplete !== false;
const wordsOn = () => state.settings.terminal?.autocompleteScreenWords !== false;

function askHistory() {
  if (history.loaded || history.asked) return;
  history.asked = true;
  send(PAGE.historyCommands, {});
}

onHost(HOST.historyCommands, m => {
  history.index = indexRuns(Array.isArray(m.entries) ? m.entries : []);
  history.loaded = true;
  history.asked = false;
  schedule();
});
// Closed terminals' history changed (a terminal closed, part of it cleared): the commands are read again when next needed.
onHost(HOST.history, () => { history.loaded = false; });

// A command run here counts at once, before the history is read again.
on(EVENTS.commandEnding, (/** @type {{ tab: Tab, exitCode: number | null }} */ { tab, exitCode }) => {
  const run = tab.running;
  if (run?.command && !tab.noHistory) addRun(history.index, { command: run.command, exitCode, at: run.startedAt, cwd: run.cwd });
});
on(EVENTS.commandStarted, (/** @type {Tab} */ tab) => {
  if (ghost.tab === tab) hideGhost();
  if (list.tab === tab) closeList();
});

/**
 * What's typed after the prompt, up to the cursor, and whether anything is after the cursor (the cursor moved back
 * into the line, or the shell drew a suggestion of its own); null when the terminal isn't at a prompt it can be
 * autocompleted at.
 * @param {Tab} tab
 * @returns {{ typed: string, after: boolean } | null}
 */
export function lineAt(tab) {
  const term = tab.view?.term;
  const input = tab.commands?.input;
  if (!term || !enabled() || !tab.shellMarks || tab.running || tab.virtual || tab.exited || !input?.marker || input.marker.isDisposed) return null;
  const buffer = term.buffer.active;
  const row = buffer.baseY + buffer.cursorY;
  if (buffer.type !== NORMAL_BUFFER || buffer.viewportY !== buffer.baseY || row < input.marker.line) return null;
  let typed = '';
  for (let y = input.marker.line; y <= row; y++) {
    const line = buffer.getLine(y);
    // A row the terminal didn't wrap onto: a command of several lines, or output.
    if (!line || (y > input.marker.line && !line.isWrapped)) return null;
    typed += line.translateToString(false, y === input.marker.line ? input.x : 0, y === row ? buffer.cursorX : term.cols);
  }
  const next = buffer.getLine(row + 1);
  const after = !!buffer.getLine(row)?.translateToString(true, buffer.cursorX).trim() || (!!next?.isWrapped && !!next.translateToString(true).trim());
  return { typed, after };
}

/** @param {Tab} tab */
const whereOf = tab => ({ cwd: tab.cwd ?? null, root: repoAt(folderOfTab(tab))?.root ?? null, now: Date.now() });

/** Works the grey text and the list out again once the terminal has drawn what came. */
function schedule() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    update();
  });
}

function update() {
  if (list.tab) renderList();
  const tab = ghost.active;
  if (!tab || !hasFocus(tab)) return hideGhost();
  const line = lineAt(tab);
  if (line) askHistory();
  const best = line && !line.after ? bestFor(history.index, line.typed, whereOf(tab)) : null;
  if (!best || !line) return hideGhost();
  showGhost(tab, best.command.slice(line.typed.length));
}

/** @param {Tab} tab */
function hasFocus(tab) {
  const term = tab.view?.term;
  return !!term?.textarea && term.textarea === term.element?.ownerDocument.activeElement;
}

// ---- The grey text ----

/**
 * Where the cursor's cell is: inside the terminal's element (for the grey text) and on its window's screen (for
 * the list), and the cell's size.
 * @param {any} term
 */
function cursorCell(term) {
  const buffer = term.buffer.active;
  const screen = find(term.element, XTERM_SCREEN).getBoundingClientRect();
  const box = term.element.getBoundingClientRect();
  const width = screen.width / term.cols;
  const height = screen.height / term.rows;
  const left = screen.left + buffer.cursorX * width;
  const top = screen.top + buffer.cursorY * height;
  return { left, top, width, height, inLeft: left - box.left, inTop: top - box.top, columns: term.cols - buffer.cursorX };
}

/** @param {Tab} tab */
function ghostEl(tab) {
  const term = /** @type {TabView} */ (tab.view).term;
  /** @type {HTMLElement} */
  const el = ghostEls.get(tab) ?? Object.assign(term.element.ownerDocument.createElement('div'), { className: 'ac-ghost' });
  ghostEls.set(tab, el);
  // The terminal's element moves with it into a window of its own and back.
  if (el.parentElement !== term.element) term.element.append(el);
  return el;
}

/**
 * @param {Tab} tab
 * @param {string} rest
 */
function showGhost(tab, rest) {
  if (ghost.tab && ghost.tab !== tab) hideGhost();
  const term = /** @type {TabView} */ (tab.view).term;
  const at = cursorCell(term);
  const el = ghostEl(tab);
  Object.assign(el.style, {
    left: `${at.inLeft}px`, top: `${at.inTop}px`, width: `${Math.max(0, at.columns * at.width)}px`,
    height: `${at.height}px`, lineHeight: `${at.height}px`,
    fontFamily: term.options.fontFamily, fontSize: `${term.options.fontSize}px`, color: term.options.theme?.foreground ?? '',
  });
  el.textContent = rest;
  el.hidden = false;
  Object.assign(ghost, { tab, rest });
}

function hideGhost() {
  if (ghost.tab) {
    const el = ghostEls.get(ghost.tab);
    if (el) el.hidden = true;
  }
  ghost.tab = null;
  ghost.rest = '';
}

/**
 * Types text at the prompt, as if it had been typed (a broadcast sends it on too).
 * @param {Tab} tab
 * @param {string} text
 */
function type(tab, text) {
  hideGhost();
  if (text) /** @type {TabView} */ (tab.view).term.input(text, true);
}

/**
 * → or End takes the grey text, Ctrl+→ its next word. True when the key was used.
 * @param {Tab} tab
 * @param {KeyboardEvent} e
 */
function ghostKey(tab, e) {
  const plain = !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey;
  const word = e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey && e.key === KEY.right;
  if (!word && !(plain && (e.key === KEY.right || e.key === KEY.end))) return false;
  // What's on the line now (a key may have gone to the shell since the grey text was drawn).
  update();
  if (ghost.tab !== tab || !ghost.rest) return false;
  type(tab, word ? nextWord(ghost.rest) : ghost.rest);
  return true;
}

// ---- The list ----

/**
 * The screen's lines above the one being typed, for its words.
 * @param {any} term
 */
function screenLines(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = buffer.viewportY; y < buffer.baseY + buffer.cursorY; y++) lines.push(buffer.getLine(y)?.translateToString(true) ?? '');
  return lines;
}

/**
 * The list's rows for what's typed: the commands, then the words on the screen.
 * @param {Tab} tab
 * @param {string} typed
 * @returns {Item[]}
 */
function itemsFor(tab, typed) {
  const commands = suggest(history.index, typed, { ...whereOf(tab), limit: MAX_COMMANDS, anywhere: true })
    .map(s => ({ kind: KIND.command, text: s.command, suggestion: s }));
  const words = wordsOn() ? screenWords(screenLines(/** @type {TabView} */ (tab.view).term), partialWord(typed), MAX_WORDS) : [];
  return [...commands, ...words.map(text => ({ kind: KIND.word, text }))];
}

/**
 * Opens the list at the focused terminal's prompt (its shortcut), or closes it when it's open there. False when the
 * terminal isn't at a prompt, so the keys go to the shell. The terminal with the keyboard is the one (the scratch
 * terminal isn't the workspace's focused one).
 * @param {Tab | null} focused the workspace's focused terminal
 */
export function toggleSuggestions(focused) {
  const tab = ghost.active && hasFocus(ghost.active) ? ghost.active : focused;
  if (!tab) return false;
  if (list.tab === tab) {
    closeList();
    return true;
  }
  if (!lineAt(tab)) return false;
  askHistory();
  Object.assign(list, { tab, index: 0 });
  ghost.active = tab;
  renderList();
  return true;
}

function closeList() {
  list.tab = null;
  list.items = [];
  listEl.hidden = true;
}

/**
 * @param {Item} item
 * @param {number} i
 * @param {string} typed
 */
function rowHtml(item, i, typed) {
  const s = item.suggestion;
  const meta = s ? `${s.here ? '<span class="ac-here">here</span>' : ''}${s.failed ? '<span class="ac-fail">failed</span>' : ''}<span class="ac-meta">${escapeHtml(timeAgo(s.at))}${s.count > 1 ? ` · ${s.count}×` : ''}</span>` : '';
  const text = item.kind === KIND.command && item.text.startsWith(typed) && typed
    ? `<b>${escapeHtml(typed)}</b>${escapeHtml(item.text.slice(typed.length))}` : escapeHtml(item.text);
  return `<div class="ac-row${i === list.index ? ' on' : ''}" data-i="${i}"><code class="ac-cmd">${text}</code>${meta}</div>`;
}

function renderList() {
  const tab = list.tab;
  const line = tab && lineAt(tab);
  if (!tab || !line || !hasFocus(tab)) return closeList();
  list.items = itemsFor(tab, line.typed);
  list.index = Math.min(list.index, Math.max(0, list.items.length - 1));
  const commands = list.items.filter(i => i.kind === KIND.command).length;
  const rows = list.items.map((item, i) => (i === 0 && commands ? '<div class="ac-group">History</div>' : i === commands ? '<div class="ac-group">On screen</div>' : '') + rowHtml(item, i, line.typed));
  listEl.innerHTML = (rows.length ? rows.join('') : '<p class="ac-empty">Nothing to suggest yet.</p>')
    + '<p class="ac-foot"><kbd>Tab</kbd> put on line <kbd>Esc</kbd> close</p>';
  placeList(/** @type {TabView} */ (tab.view).term);
}

/** @param {any} term */
function placeList(term) {
  const doc = term.element.ownerDocument;
  if (listEl.ownerDocument !== doc || !listEl.isConnected) doc.body.append(listEl);
  listEl.hidden = false;
  const at = cursorCell(term);
  const view = doc.defaultView ?? window;
  const below = at.top + at.height + GAP_PX;
  const top = below + listEl.offsetHeight > view.innerHeight ? at.top - listEl.offsetHeight - GAP_PX : below;
  Object.assign(listEl.style, {
    left: `${Math.round(Math.max(GAP_PX, Math.min(at.left, view.innerWidth - listEl.offsetWidth - GAP_PX)))}px`, top: `${Math.round(Math.max(GAP_PX, top))}px`,
  });
}

/**
 * Puts a row on the line: the rest of a command that starts with what's typed (or the command in place of it), or
 * the rest of a word.
 * @param {number} i
 */
function take(i) {
  const item = list.items[i];
  const tab = list.tab;
  const line = tab && lineAt(tab);
  closeList();
  if (!item || !tab || !line) return;
  if (item.kind === KIND.word) type(tab, item.text.slice(partialWord(line.typed).length));
  else if (item.text.startsWith(line.typed)) type(tab, item.text.slice(line.typed.length));
  else type(tab, BACKSPACE.repeat([...line.typed].length) + item.text);
}

/**
 * ↑↓, Tab, Enter and Esc while the list is open. True when the key was used.
 * @param {KeyboardEvent} e
 */
function listKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const count = list.items.length;
  if (e.key === KEY.down || e.key === KEY.up) {
    if (count) list.index = (list.index + (e.key === KEY.down ? 1 : -1) + count) % count;
    renderList();
  } else if ((e.key === KEY.enter || e.key === KEY.tab) && count) {
    take(list.index);
  } else if (e.key === KEY.escape) {
    closeList();
  } else {
    return false;
  }
  return true;
}

listEl.addEventListener('mousedown', e => {
  e.preventDefault(); // the terminal keeps the keyboard
  const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-i]'));
  if (row) take(Number(row.dataset.i));
});

// ---- Wiring ----

addInputHook((tab, term, e) => {
  if (e.type !== 'keydown' || e.isComposing) return true;
  ghost.active = tab;
  const used = (list.tab === tab && listKey(e)) || (ghost.tab === tab && !!ghost.rest && ghostKey(tab, e));
  if (!used) return true;
  e.preventDefault();
  return false;
});

on(EVENTS.terminalOpened, (/** @type {Tab} */ tab) => {
  const { term } = /** @type {TabView} */ (tab.view);
  const changed = () => {
    // The terminal with the keyboard is the one typed in (a paste or a click there counts too).
    if (hasFocus(tab)) ghost.active = tab;
    if (ghost.active === tab || list.tab === tab) schedule();
  };
  term.onWriteParsed(changed);
  term.onCursorMove(changed);
  term.onResize(changed);
  term.onScroll(changed);
  term.textarea?.addEventListener('blur', () => { if (ghost.active === tab) schedule(); });
  term.textarea?.addEventListener('focus', () => { ghost.active = tab; schedule(); });
});
// The setting turned off: nothing shows.
on(EVENTS.settings, schedule);
