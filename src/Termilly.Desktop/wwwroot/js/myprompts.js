// @ts-check
// My prompts: what you asked Claude Code in a terminal, by day and time, from the header's button. Each one leads to
// where it is in the terminal's output. The host has them (PromptsHandler): Termilly's own record, kept from the
// prompt hook as history is, and the sessions' transcripts on this PC for older ones. With neither, they're read from
// the prompts the output still shows (no times then).

import { PAGE } from './protocol.js';
import { request, send } from './host.js';
import { HOOK_EVENT } from './constants.js';
import { state, persist } from './store.js';
import { openPopover, closePopover, isOpen } from './popups.js';
import { escapeHtml, highlight, ICONS } from './ui.js';
import { bufferLines } from './terminals.js';
import { focusTab, switchWorkspace } from './panes.js';
import { find, targetOf } from './dom.js';

/** A terminal keeps this many of its Claude Code sessions' ids (a /clear starts a new one). */
const KEPT_SESSIONS = 20;
/** A Claude Code session id. */
const SESSION_ID = /^[0-9a-f][0-9a-f-]{7,63}$/i;
/** How Claude Code shows a prompt you sent: "> " (or "❯ ") and its text, its next lines indented. */
const PROMPT_LINE = /^[>❯]\s(.*)$/;
const MORE_LINE = /^ {2}\S/;
/** A prompt is matched in the output by this many characters of its start. */
const MATCH_CHARS = 60;
/** How many of a prompt's lines in the output are read to match it. */
const MATCH_LINES = 4;
/** Rows of output shown above a prompt it scrolls to. */
const ABOVE_ROWS = 2;
const DAY_MS = 86_400_000;

/** @typedef {{ text: string, at: string | null }} Prompt */
/** @typedef {{ prompt: Prompt, line: number }} Found */

/**
 * The terminal ran this Claude Code session: kept, so its prompts are listed even after a /clear or a restart.
 * @param {Tab} tab
 */
export function rememberSession(tab) {
  const session = tab.agent?.session;
  if (!session || !SESSION_ID.test(session) || tab.agentSessions?.at(-1) === session) return;
  tab.agentSessions = [...(tab.agentSessions ?? []).filter(s => s !== session), session].slice(-KEPT_SESSIONS);
  persist();
}

/**
 * Keeps a prompt the terminal's agent was sent (the prompt hook's), unless the terminal keeps no history.
 * @param {Tab} tab
 * @param {{ event?: string, prompt?: string | null, session?: string | null }} m
 */
export function recordPrompt(tab, m) {
  if (m.event !== HOOK_EVENT.userPromptSubmit || !m.prompt || tab.noHistory) return;
  send(PAGE.promptAdd, { id: tab.id, session: m.session ?? null, text: m.prompt });
}

/** @param {Tab} tab */
const sessionsOf = tab => /** @type {string[]} */ ([...new Set([...(tab.agentSessions ?? []), tab.hibernated?.session, tab.agent?.session, tab.start?.resumeSession]
  .filter(s => typeof s === 'string' && SESSION_ID.test(s)))]);

/** Whether the terminal has prompts to list: Claude Code has run in it. @param {Tab} tab */
export const hasPrompts = tab => !!tab.agentSeen || !!tab.agentSessions?.length;

/** @param {string} s */
const norm = s => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The prompts the output shows, top to bottom: each one's line and its text (its first few lines).
 * @param {string[]} lines
 */
function shownPrompts(lines) {
  /** @type {{ line: number, text: string }[]} */
  const shown = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PROMPT_LINE.exec(lines[i]);
    if (!m || !m[1].trim()) continue;
    let text = m[1];
    for (let j = i + 1; j < Math.min(lines.length, i + MATCH_LINES) && MORE_LINE.test(lines[j]); j++) text += ` ${lines[j]}`;
    shown.push({ line: i, text: norm(text) });
  }
  return shown;
}

/**
 * Where each prompt is in the output: matched newest first, from the bottom up, so a prompt sent twice finds its
 * own place. -1 for one the output no longer shows (cleared, or before the scrollback starts).
 * @param {Prompt[]} prompts
 * @param {{ line: number, text: string }[]} shown
 */
function place(prompts, shown) {
  const lines = prompts.map(() => -1);
  let below = shown.length;
  for (let p = prompts.length - 1; p >= 0; p--) {
    const want = norm(prompts[p].text).slice(0, MATCH_CHARS);
    for (let s = below - 1; s >= 0; s--) {
      const text = shown[s].text;
      if (text.startsWith(want) || (text.length >= MATCH_CHARS / 2 && want.startsWith(text))) {
        lines[p] = shown[s].line;
        below = s;
        break;
      }
    }
  }
  return lines;
}

const pop = document.createElement('section');
pop.className = 'popover inbox prompts-pop';
pop.setAttribute('aria-label', 'My prompts');
pop.hidden = true;
pop.innerHTML = `
  <div class="inbox-head"><span class="section-head">My prompts</span><span class="prompts-count"></span></div>
  <div class="prompts-filter"><input type="text" placeholder="Filter" spellcheck="false" aria-label="Filter prompts"></div>
  <div class="inbox-list prompts-list" role="listbox"></div>`;
const listEl = find(pop, '.prompts-list');
const filterEl = /** @type {HTMLInputElement} */ (find(pop, 'input'));

/** @type {{ tab: Tab, found: Found[], lines: string[] & { rows?: number[] } } | null} */
let open = null;

/** "Today", "Yesterday", or the day's date. @param {Date} d */
function dayLabel(d) {
  const start = (/** @type {Date} */ x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((start(new Date()) - start(d)) / DAY_MS);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

function render() {
  if (!open) return;
  const want = norm(filterEl.value);
  const rows = open.found.map((f, i) => ({ ...f, i })).filter(f => !want || norm(f.prompt.text).includes(want)).reverse();
  find(pop, '.prompts-count').textContent = open.found.length ? String(open.found.length) : '';
  let day = '';
  listEl.innerHTML = rows.map(({ prompt, line, i }) => {
    const when = prompt.at ? new Date(prompt.at) : null;
    const label = when ? dayLabel(when) : 'In the output';
    const head = label !== day ? `<div class="prompts-day">${escapeHtml(label)}</div>` : '';
    day = label;
    const gone = line < 0;
    return `${head}<div class="prompt-row${gone ? ' gone' : ''}" role="option" tabindex="-1" data-i="${i}"
      title="${gone ? 'No longer in this terminal’s output' : 'Show it in the terminal'}">
      <span class="prompt-time">${when ? escapeHtml(when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })) : ''}</span>
      <span class="prompt-text">${want ? highlight(prompt.text, filterEl.value.trim()) : escapeHtml(prompt.text)}</span>
      <button class="prompt-copy" data-copy="${i}" title="Copy" aria-label="Copy">${ICONS.copy}</button>
    </div>`;
  }).join('') || `<p class="change-empty">${open.found.length ? 'No prompt has that text.' : 'No prompts yet.'}</p>`;
}

/**
 * Scrolls the terminal to a prompt and selects its first line.
 * @param {Found} f
 */
function goTo(f) {
  const { tab, lines } = /** @type {NonNullable<typeof open>} */ (open);
  const row = lines.rows?.[f.line];
  const term = tab.view?.term;
  closePopover(pop);
  if (tab.wsId !== state.activeId) switchWorkspace(tab.wsId);
  focusTab(tab);
  if (!term || row === undefined) return;
  term.scrollToLine(Math.max(0, row - ABOVE_ROWS));
  term.select(0, row, lines[f.line].length);
}

/**
 * The prompts: Termilly's record and the transcripts on this PC, else (none of either) the ones the output shows.
 * @param {Tab} tab
 * @param {{ line: number, text: string }[]} shown
 * @returns {Promise<Prompt[]>}
 */
async function promptsOf(tab, shown) {
  const reply = await request(PAGE.promptsList, { id: tab.id, sessions: sessionsOf(tab) });
  const listed = /** @type {Prompt[]} */ (reply?.prompts ?? []);
  return listed.length ? listed : shown.map(s => ({ text: s.text, at: null }));
}

/**
 * Opens a terminal's prompts under its header button (again: closes them).
 * @param {Tab} tab
 * @param {HTMLElement} anchor
 */
export async function openPrompts(tab, anchor) {
  if (isOpen(pop) && open?.tab === tab) return closePopover(pop);
  const lines = bufferLines(tab);
  const shown = shownPrompts(lines);
  const prompts = await promptsOf(tab, shown);
  const at = place(prompts, shown);
  open = { tab, lines, found: prompts.map((prompt, i) => ({ prompt, line: at[i] })) };
  filterEl.value = '';
  render();
  openPopover(pop, anchor, { dynamic: true, onClose: () => { open = null; } });
  filterEl.focus();
}

filterEl.addEventListener('input', render);
filterEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !open) return;
  const first = /** @type {HTMLElement | null} */ (listEl.querySelector('.prompt-row:not(.gone)'));
  if (first) goTo(open.found[Number(first.dataset.i)]);
});
listEl.addEventListener('click', e => {
  if (!open) return;
  const copy = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-copy]'));
  if (copy) {
    navigator.clipboard.writeText(open.found[Number(copy.dataset.copy)].prompt.text);
    return;
  }
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('.prompt-row'));
  if (row && !row.classList.contains('gone')) goTo(open.found[Number(row.dataset.i)]);
});
