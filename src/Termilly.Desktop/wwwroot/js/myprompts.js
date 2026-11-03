// @ts-check
// Prompt history: what you asked Claude Code in a terminal, by day and time, from the header's button. Each one leads to
// where it is in the terminal's output. The host has them (PromptsHandler): Termilly's own record, kept from the
// prompt hook as history is, and the sessions' transcripts on this PC for older ones. With neither, they're read from
// the prompts the output still shows (no times then). Another Termilly computer's terminal shown here gets that
// computer's list, when it allows it (Settings › Remote › Prompt history there; Phone/PcPromptsApi.cs).

import { PAGE, HOST } from './protocol.js';
import { request, send, onHost } from './host.js';
import { HOOK_EVENT } from './constants.js';
import { state, persist } from './store.js';
import { openPopover, closePopover, isOpen } from './popups.js';
import { escapeHtml, highlight, ICONS } from './ui.js';
import { bufferLines } from './terminals.js';
import { focusTab, switchWorkspace } from './panes.js';
import { find, targetOf } from './dom.js';
import { showToast, TOAST } from './toasts.js';
import { AGENT_STEP } from './constants.js';
import { shownSteps, placeSteps, stepRowHtml } from './agentsteps.js';

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
/** @typedef {import('./agentsteps.js').AgentStep} AgentStep */
/** @typedef {import('./agentsteps.js').PlacedStep} PlacedStep */

/** What the list shows: prompts (each with Claude's last reply under it), all replies, or all tool calls. */
const MODE = Object.freeze({ prompts: 'prompts', replies: 'replies', tools: 'tools' });
/** The list's title, and its button's on an agent terminal's header. */
export const PROMPTS_TITLE = 'Prompts and replies';
/** The kind of step each of the other lists shows. */
const STEP_KIND = Object.freeze({ [MODE.replies]: AGENT_STEP.reply, [MODE.tools]: AGENT_STEP.tool });
/** The list's count, its line about hidden prompts, and a row no longer in the output. */
const COUNT = '.prompts-count';
const CLEARED = '.prompts-cleared';
const GONE = 'gone';

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

/**
 * Whether the terminal has prompts to list: Claude Code has run in it (another computer's terminal: that computer
 * says so, and lets this one see them).
 * @param {Tab} tab
 */
export const hasPrompts = tab => (tab.virtual ? !!tab.virtual.prompts : !!tab.agentSeen || !!tab.agentSessions?.length);

// Another Termilly computer opens Prompt history for one of this PC's terminals: its sessions, for the host to read.
onHost(HOST.pcSessions, m => {
  const tab = state.tabs.get(m.args?.pane);
  send(PAGE.apiResult, { requestId: m.requestId, result: { found: !!tab && !tab.virtual, sessions: tab ? sessionsOf(tab) : [] } });
});

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
pop.setAttribute('aria-label', PROMPTS_TITLE);
pop.hidden = true;
pop.innerHTML = `
  <div class="inbox-head"><span class="section-head">${PROMPTS_TITLE}</span><span class="prompts-count"></span>
    <button class="btn small" data-clear title="Hides what this list shows now. Nothing is deleted: Show them again brings it back. Prompts, Replies and Tool calls each clear on their own.">Clear</button></div>
  <div class="prompts-modes"><span class="seg" role="tablist">
    <button data-mode="${MODE.prompts}" role="tab" title="Each prompt, with Claude’s last reply to it">Prompts</button>
    <button data-mode="${MODE.replies}" role="tab" title="Everything Claude wrote">Replies</button>
    <button data-mode="${MODE.tools}" role="tab" title="The commands Claude ran and the files it read and changed">Tool calls</button></span></div>
  <div class="prompts-filter"><input type="text" placeholder="Filter" spellcheck="false" aria-label="Filter"></div>
  <div class="inbox-list prompts-list" role="listbox"></div>
  <div class="inbox-foot prompts-cleared" hidden><span></span><button class="btn small" data-unclear>Show them again</button></div>`;
const listEl = find(pop, '.prompts-list');
const filterEl = /** @type {HTMLInputElement} */ (find(pop, 'input'));

/**
 * The list open now: its terminal, its output, the prompts and Claude's steps found, what it shows, and the prompts
 * whose every step is shown.
 * @type {{ tab: Tab, found: Found[], steps: PlacedStep[], lines: string[] & { rows?: number[] }, mode: string,
 *   expanded: Set<number> } | null}
 */
let open = null;

/**
 * Where each terminal's output stood when its list was cleared: prompts read from the output (no times) above it
 * stay hidden. Gone after a restart, when those show again.
 * @type {WeakMap<Tab, { line: number, isDisposed: boolean, dispose: () => void }>}
 */
const clearMarks = new WeakMap();

/**
 * Whether a prompt was listed when the list was last cleared (it's hidden then).
 * @param {Tab} tab
 * @param {Found} f
 * @param {number[] | undefined} rows
 */
function cleared(tab, f, rows) {
  const at = tab.promptsClearedAt;
  if (!at) return false;
  if (f.prompt.at) return Date.parse(f.prompt.at) <= at;
  const mark = clearMarks.get(tab);
  const row = rows?.[f.line];
  return !!mark && !mark.isDisposed && row !== undefined && row <= mark.line;
}

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
  for (const b of /** @type {NodeListOf<HTMLElement>} */ (pop.querySelectorAll('[data-mode]'))) b.classList.toggle('on', b.dataset.mode === open.mode);
  find(pop, '.prompts-modes').hidden = !open.steps.length;
  if (open.mode === MODE.prompts) renderPrompts();
  else renderSteps(open.mode === MODE.tools ? AGENT_STEP.tool : AGENT_STEP.reply);
}

/**
 * All of Claude's replies, or all its tool calls, newest first. Each list has its own Clear: those from before it
 * are hidden until Show them again.
 * @param {string} kind
 */
function renderSteps(kind) {
  const { tab, steps } = /** @type {NonNullable<typeof open>} */ (open);
  const want = norm(filterEl.value);
  const clearedAt = tab.stepsClearedAt?.[kind] ?? 0;
  const ofKind = steps.map((p, k) => ({ p, k })).filter(({ p }) => p.step.kind === kind);
  const listed = ofKind.filter(({ p }) => Date.parse(p.step.at) > clearedAt);
  const shown = listed.filter(({ p }) => !want || norm(`${p.step.tool ?? ''} ${p.step.text}`).includes(want)).reverse();
  const hidden = ofKind.length - listed.length;
  showCounts(listed.length, hidden);
  const empty = want ? 'Nothing has that text.' : hidden ? 'Nothing since you cleared it.' : kind === AGENT_STEP.tool ? 'No tool calls yet.' : 'No replies yet.';
  listEl.innerHTML = shown.map(({ p, k }) => stepRowHtml(p, k, filterEl.value.trim())).join('') || `<p class="change-empty">${empty}</p>`;
}

/**
 * The steps of one prompt under it: its last reply, or (expanded) every reply and tool call, in order.
 * @param {number} i the prompt's index
 */
function turnHtml(i) {
  const { steps, expanded } = /** @type {NonNullable<typeof open>} */ (open);
  const own = steps.map((p, k) => ({ p, k })).filter(({ p }) => p.turn === i);
  if (!own.length) return '';
  const all = expanded.has(i);
  const rows = (all ? own : own.filter(({ p }) => p.last)).map(({ p, k }) => stepRowHtml(p, k, '', { nested: true })).join('');
  const more = own.length - (all ? 0 : own.filter(({ p }) => p.last).length);
  const toggle = all || more ? `<button class="step-more" data-turn="${i}">${all ? 'Show the last reply only' : `Show all ${own.length} steps`}</button>` : '';
  return `<div class="turn-steps">${rows}${toggle}</div>`;
}

/**
 * The head's count of what's listed and its Clear, and the line saying how many Clear hid.
 * @param {number} listed
 * @param {number} hidden
 */
function showCounts(listed, hidden) {
  find(pop, COUNT).textContent = listed ? String(listed) : '';
  find(pop, '[data-clear]').hidden = !listed;
  const foot = find(pop, CLEARED);
  foot.hidden = !hidden;
  find(foot, 'span').textContent = hidden ? `${hidden} hidden` : '';
}

function renderPrompts() {
  const want = norm(filterEl.value);
  const { tab, lines } = /** @type {NonNullable<typeof open>} */ (open);
  const { found } = /** @type {NonNullable<typeof open>} */ (open);
  const listed = found.map((f, i) => ({ ...f, i })).filter(f => !cleared(tab, f, lines.rows));
  const rows = listed.filter(f => !want || norm(f.prompt.text).includes(want)).reverse();
  const hidden = found.length - listed.length;
  showCounts(listed.length, hidden);
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
    </div>${turnHtml(i)}`;
  }).join('') || `<p class="change-empty">${listed.length ? 'No prompt has that text.' : hidden ? 'Nothing since you cleared it.' : 'No prompts yet.'}</p>`;
}

/**
 * Scrolls the terminal to a prompt (or one of Claude's steps) and selects its first line.
 * @param {{ line: number }} f
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
 * The prompts: Termilly's record and the transcripts on this PC, else (none of either) the ones the output shows; and
 * what Claude did between them, from the transcripts.
 * @param {Tab} tab
 * @param {{ line: number, text: string }[]} shown
 * @returns {Promise<{ prompts: Prompt[], steps: AgentStep[] }>}
 */
async function promptsOf(tab, shown) {
  const reply = tab.virtual
    ? await request(PAGE.pcPrompts, { tab: tab.id })
    : await request(PAGE.promptsList, { id: tab.id, sessions: sessionsOf(tab) });
  if (reply?.error) showToast({ text: reply.error, state: TOAST.failed });
  const listed = /** @type {Prompt[]} */ (reply?.prompts ?? []);
  return { prompts: listed.length ? listed : shown.map(s => ({ text: s.text, at: null })), steps: reply?.steps ?? [] };
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
  const { prompts, steps } = await promptsOf(tab, shown);
  const at = place(prompts, shown);
  open = {
    tab, lines, found: prompts.map((prompt, i) => ({ prompt, line: at[i] })), steps: placeSteps(steps, prompts, shownSteps(lines)),
    mode: open?.tab === tab ? open.mode : MODE.prompts, expanded: new Set(),
  };
  filterEl.value = '';
  render();
  openPopover(pop, anchor, { dynamic: true, onClose: () => { open = null; } });
  filterEl.focus();
}

filterEl.addEventListener('input', render);
pop.addEventListener('click', e => {
  if (!open) return;
  const { tab } = open;
  const mode = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-mode]'));
  if (mode) {
    open.mode = /** @type {string} */ (mode.dataset.mode);
    render();
    filterEl.focus();
    return;
  }
  const kind = STEP_KIND[/** @type {keyof typeof STEP_KIND} */ (open.mode)];
  if (kind && targetOf(e).closest('[data-clear], [data-unclear]')) {
    // Replies and Tool calls: each list is cleared on its own.
    const clearedAt = { ...tab.stepsClearedAt };
    if (targetOf(e).closest('[data-clear]')) clearedAt[kind] = Date.now(); else delete clearedAt[kind];
    tab.stepsClearedAt = clearedAt;
  } else if (targetOf(e).closest('[data-clear]')) {
    tab.promptsClearedAt = Date.now();
    const mark = tab.view?.term?.registerMarker(0);
    if (mark) clearMarks.set(tab, mark);
  } else if (targetOf(e).closest('[data-unclear]')) {
    tab.promptsClearedAt = null;
    clearMarks.get(tab)?.dispose();
    clearMarks.delete(tab);
  } else return;
  persist();
  render();
});
filterEl.addEventListener('keydown', e => {
  if (e.key !== 'Enter' || !open) return;
  const first = /** @type {HTMLElement | null} */ (listEl.querySelector(':is(.prompt-row, .step-row):not(.gone)'));
  if (first) goTo(first.dataset.s !== undefined ? open.steps[Number(first.dataset.s)] : open.found[Number(first.dataset.i)]);
});
listEl.addEventListener('click', e => {
  if (!open) return;
  if (stepClick(e)) return;
  const copy = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-copy]'));
  if (copy) {
    navigator.clipboard.writeText(open.found[Number(copy.dataset.copy)].prompt.text);
    return;
  }
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('.prompt-row'));
  if (row && !row.classList.contains(GONE)) goTo(open.found[Number(row.dataset.i)]);
});

/**
 * A click on one of Claude's steps: every step of a prompt shown or not, one copied, or gone to. True when it was one.
 * @param {MouseEvent} e
 */
function stepClick(e) {
  const o = /** @type {NonNullable<typeof open>} */ (open);
  const more = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-turn]'));
  if (more) {
    const i = Number(more.dataset.turn);
    if (o.expanded.has(i)) o.expanded.delete(i); else o.expanded.add(i);
    render();
    return true;
  }
  const copy = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-copy-step]'));
  if (copy) {
    const { step } = o.steps[Number(copy.dataset.copyStep)];
    navigator.clipboard.writeText(step.kind === AGENT_STEP.tool ? String(step.tool) + "(" + step.text + ")" : step.text);
    return true;
  }
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest('.step-row'));
  if (!row) return false;
  if (!row.classList.contains(GONE)) goTo(o.steps[Number(row.dataset.s)]);
  return true;
}
