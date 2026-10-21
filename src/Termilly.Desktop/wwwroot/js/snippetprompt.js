// @ts-check
// `snippet:name` typed at an empty prompt runs that snippet. The keys never reach the shell: from the first letter
// that could start `snippet:`, they wait here and show over the prompt as if the shell had echoed them. The first key
// that doesn't fit sends them on, in order, so "ssh" or "set" types as usual. Once `snippet:` is there, a list at the
// cursor shows the matching snippets with their commands and the values they ask for: Up and Down pick, Tab or Enter
// runs it (the run form asks for its values first), Esc types what was held at the prompt after all.
// Only at a prompt the shell marked (shell integration) with nothing typed since (or all of it deleted again), on
// the normal screen (not vim's), in a terminal with its own shell (not a tmux pane).

import { on, wsById, EVENTS } from './store.js';
import { setInputHook, isTerminalReply } from './terminals.js';
import { allSnippets, placeholders, runSnippetIn, scopeLabel } from './snippets.js';
import { escapeHtml } from './ui.js';
import { find, XTERM_SCREEN } from './dom.js';
import { SNIPPET_PREFIX, startsPrefix, hasPrefix, matchSnippets } from './snippetmatch.js';
import { inputEmpty } from './commands.js';

/** How many matches the list shows. */
const MAX_SHOWN = 8;
/** Between the typed line and the list under it, in px. */
const GAP_PX = 4;
/** xterm's buffer while no full-screen program (vim, less) has the alternate one. */
const NORMAL_BUFFER = 'normal';
/** Keys that are only modifiers: Shift for the ':' of `snippet:` mustn't send the held letters on. */
const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'AltGraph']);
const KEY = Object.freeze({ up: 'ArrowUp', down: 'ArrowDown', enter: 'Enter', tab: 'Tab', escape: 'Escape', backspace: 'Backspace' });

/** Terminals at a fresh prompt with nothing typed since (the shell marked it, no key has gone to it). */
const untouched = new WeakSet();
on(EVENTS.prompt, (/** @type {Tab} */ tab) => untouched.add(tab));
on(EVENTS.terminalOpened, (/** @type {Tab} */ tab) => {
  /** @type {TabView} */ (tab.view).term.onData((/** @type {string} */ data) => { if (!isTerminalReply(data)) untouched.delete(tab); });
});

/**
 * What's held back from the shell: the terminal, the text, and which match is picked.
 * @type {{ tab: Tab | null, term: any, text: string, index: number }}
 */
let held = { tab: null, term: null, text: '', index: 0 };

const typed = document.createElement('div');
typed.className = 'snippet-typed';
typed.hidden = true;
const list = document.createElement('div');
list.className = 'popover snippet-suggest';
list.hidden = true;
document.body.append(typed, list);

/**
 * The character a key types, or '' for any other key (Ctrl and Alt combinations included).
 * @param {KeyboardEvent} e
 */
const charOf = e => (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey ? e.key : '');

/**
 * @param {Tab} tab
 * @param {any} term
 */
const canStart = (tab, term) => (untouched.has(tab) || inputEmpty(tab)) && !!tab.shellMarks && !tab.virtual && !tab.exited
  && term.buffer.active.type === NORMAL_BUFFER;

/** The snippets that match what's typed after `snippet:`. */
const matches = () => matchSnippets(allSnippets(wsById(/** @type {Tab} */ (held.tab).wsId)), held.text.slice(SNIPPET_PREFIX.length));

function clear() {
  held = { tab: null, term: null, text: '', index: 0 };
  typed.hidden = true;
  list.hidden = true;
}

/** Gives the held keys to the shell after all, as if they had been typed just now. */
function release() {
  const { term, text } = held;
  clear();
  if (text) term.input(text, true);
}

/** Runs the picked snippet in the terminal it was typed in; nothing typed reaches the shell. */
function take() {
  const snippet = matches()[held.index];
  if (!snippet) return;
  const tab = /** @type {Tab} */ (held.tab);
  clear();
  // A snippet that doesn't press Enter leaves its text at the prompt. Cancelled, the prompt is still empty and
  // `snippet:` works there again.
  runSnippetIn(snippet, tab).then(sent => { if (sent) untouched.delete(tab); });
}

setInputHook((tab, term, e) => {
  if (e.type !== 'keydown' || e.isComposing) return true;
  if (held.tab && held.tab !== tab) release();
  const keep = held.tab ? holdKey(e) : startHolding(tab, term, e);
  if (!keep) return true;
  e.preventDefault(); // no keypress, so xterm doesn't type it either
  if (held.tab) draw();
  return false;
});

/**
 * A key at an untouched prompt: the first letter of `snippet:` waits here.
 * @param {Tab} tab
 * @param {any} term
 * @param {KeyboardEvent} e
 */
function startHolding(tab, term, e) {
  const ch = charOf(e);
  if (!ch || !startsPrefix(ch) || !canStart(tab, term)) return false;
  held = { tab, term, text: ch, index: 0 };
  return true;
}

/**
 * A key while something is held: true when it stays here.
 * @param {KeyboardEvent} e
 */
function holdKey(e) {
  if (MODIFIER_KEYS.has(e.key)) return false;
  const ch = charOf(e);
  if (ch && (hasPrefix(held.text + ch) || startsPrefix(held.text + ch))) {
    held.text += ch;
    held.index = 0;
    return true;
  }
  if (e.key === KEY.backspace) {
    held.text = held.text.slice(0, -1);
    if (!held.text) clear();
    return true;
  }
  if (hasPrefix(held.text) && pickKey(e)) return true;
  release();
  return false;
}

/**
 * Up, Down, Tab, Enter and Esc while the list is open.
 * @param {KeyboardEvent} e
 */
function pickKey(e) {
  if (e.ctrlKey || e.altKey || e.metaKey) return false;
  const count = Math.min(matches().length, MAX_SHOWN);
  if (e.key === KEY.down || e.key === KEY.up) {
    if (count) held.index = (held.index + (e.key === KEY.down ? 1 : -1) + count) % count;
  } else if (e.key === KEY.enter || e.key === KEY.tab) {
    take();
  } else if (e.key === KEY.escape) {
    release();
  } else {
    return false;
  }
  return true;
}

// ---- Drawing ----

/** Where the cursor's cell is on screen, and the cell's size. */
function cursorCell() {
  const { term } = held;
  const buffer = term.buffer.active;
  const screen = find(term.element, XTERM_SCREEN).getBoundingClientRect();
  const cell = { width: screen.width / term.cols, height: screen.height / term.rows };
  return {
    left: screen.left + buffer.cursorX * cell.width,
    top: screen.top + (buffer.baseY + buffer.cursorY - buffer.viewportY) * cell.height,
    height: cell.height,
  };
}

/** The held text over the prompt, in the terminal's font, and the list under it once `snippet:` is typed. */
function draw() {
  const { term } = held;
  const at = cursorCell();
  Object.assign(typed.style, {
    left: `${Math.round(at.left)}px`, top: `${Math.round(at.top)}px`, height: `${at.height}px`, lineHeight: `${at.height}px`,
    fontFamily: term.options.fontFamily, fontSize: `${term.options.fontSize}px`, color: term.options.theme?.foreground ?? '',
  });
  typed.textContent = held.text;
  typed.hidden = false;
  if (!held.text || !hasPrefix(held.text)) {
    list.hidden = true;
    return;
  }
  list.innerHTML = listHtml(matches().slice(0, MAX_SHOWN));
  list.hidden = false;
  const below = at.top + at.height + GAP_PX;
  const top = below + list.offsetHeight > innerHeight ? at.top - list.offsetHeight - GAP_PX : below;
  Object.assign(list.style, { left: `${Math.round(Math.min(at.left, innerWidth - list.offsetWidth - GAP_PX))}px`, top: `${Math.round(top)}px` });
}

/**
 * The list's rows: name, where it's kept, the command and the values it asks for.
 * @param {import('./snippets.js').Snippet[]} shown
 */
function listHtml(shown) {
  const query = held.text.slice(SNIPPET_PREFIX.length);
  if (!shown.length) {
    return `<p class="set-desc snippet-empty">No snippet matches “${escapeHtml(query)}”. Esc types it at the prompt.</p>`;
  }
  const rows = shown.map((s, i) => {
    const vars = placeholders(s.command);
    return `<div class="snippet-item${i === held.index ? ' on' : ''}" data-i="${i}">
      <div class="snippet-text"><div class="snippet-name">${escapeHtml(s.name)}<span class="snippet-scope">${scopeLabel(s)}</span></div>
        <code class="snippet-cmd">${escapeHtml(s.command)}</code>
        ${vars.length ? `<div class="snippet-vars">${vars.map(v => `<span class="snippet-var">${escapeHtml(v.def ? `${v.name} = ${v.def}` : v.name)}</span>`).join('')}</div>` : ''}</div>
    </div>`;
  });
  return `${rows.join('')}<p class="snippet-suggest-foot"><kbd>↑</kbd><kbd>↓</kbd> pick, <kbd>Enter</kbd> runs, <kbd>Esc</kbd> types it as text</p>`;
}

// A click anywhere else gives the held keys to the shell, as typed.
document.addEventListener('mousedown', e => {
  if (held.tab && !list.contains(/** @type {Node} */ (e.target))) release();
}, true);

// A click on a row runs it; mousedown is kept so the terminal keeps the keyboard.
list.addEventListener('mousedown', e => {
  e.preventDefault();
  const row = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (e.target).closest('[data-i]'));
  if (!row || !held.tab) return;
  held.index = Number(row.dataset.i);
  take();
});
