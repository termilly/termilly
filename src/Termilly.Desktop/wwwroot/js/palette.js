// @ts-check
// Master search (Ctrl+Shift+F): open tabs, closed sessions, workspaces and commands in one list,
// matching names, tags, workspace, shell and terminal output.

import { PAGE, HOST } from './protocol.js';
import { send, onHost } from './host.js';
import {
  state, on, wsById, tabsOf, tabTitle, profileOf, ensureTag, isSshProfile, EVENTS, DEFAULT_TAB_TITLE,
} from './store.js';
import { closeAll } from './popups.js';
import { badgeHtml, tabBadgeHtml, tagChipHtml, escapeHtml, highlight, snippet, formatWhen, ICONS, BADGE_SIZE } from './ui.js';
import { bufferLines } from './terminals.js';
import { focusTab, focusedTab, switchWorkspace, newTab, restoreFocus } from './panes.js';
import { formatDuration } from './commands.js';
import { ensureActiveWorkspace, createWorkspace, freeName } from './workspaces.js';
import { fuzzyMatch, highlightPositions } from './fuzzy.js';
import { pickFolder } from './dialogs.js';
import { probeFolder, offerLayout, applyLayout } from './layouts.js';
import { notesFor } from './notes.js';
import { byId, targetOf } from './dom.js';

/**
 * A closed terminal the host keeps (Host_history's entries), as panes.js recordHistory sent it.
 * @typedef {{ id: string, name: string, customName?: string | null, profile: string, tags?: string[] | null,
 *   note?: Note | null, wsId?: string | null, wsName?: string | null, closedAt: number, noHistory?: boolean,
 *   lines?: string[] | null }} HistoryEntry
 */
/**
 * A command a terminal ran (Host_historyCommands' entries), as commands.js sent it; host is the PC it ran on, when
 * it came from another one.
 * @typedef {{ command: string, exitCode?: number | null, durationMs?: number | null, at: number, cwd?: string | null,
 *   terminal?: string | null, workspace?: string | null, host?: string | null }} RanEntry
 */
/**
 * An app command the palette can run (setCommands).
 * @typedef {{ label: string, hint?: string, keywords?: string, icon?: string, run: () => unknown }} PaletteCommand
 */
/**
 * A search: the free text and the tag:, ws: and shell: filters (all lower-case).
 * @typedef {{ text: string, tag: string | null, ws: string | null, shell: string | null }} Query
 */
/**
 * A terminal's output lines; rows[i] is the buffer row line i starts on (open terminals only, see bufferLines).
 * @typedef {string[] & { rows?: number[] }} Lines
 */
/**
 * The output lines a search matched: their indexes, the one shown (at) and its index (line).
 * @typedef {{ hits: number[], at: number, line: number, count: number, inOutput: true }} OutputHit
 */
/** @typedef {{ hits?: undefined, at?: undefined, line?: undefined, count?: undefined, inOutput?: undefined }} NoHit */
/**
 * How a terminal matched: its rank (lower is better), what matched, and the output lines that did.
 * @typedef {{ rank: number, on?: string } & (OutputHit | NoHit)} TextMatch
 */
/** @typedef {{ kind: 'open', tab: Tab, ws: Workspace, lines: Lines, match: TextMatch, rank: number }} OpenResult */
/**
 * @typedef {{ kind: 'closed', entry: HistoryEntry, profile: SessionProfile | undefined, lines: Lines,
 *   match: TextMatch, rank: number }} ClosedResult
 */
/** @typedef {{ kind: 'workspaces', ws: Workspace }} WorkspaceResult */
/** @typedef {{ kind: 'commands', cmd: PaletteCommand }} CommandResult */
/** @typedef {{ kind: 'ran', entry: RanEntry, words: string[] }} RanResult */
/**
 * A place "Go to" offers: a workspace, a recent folder, an SSH host or a closed terminal.
 * @typedef {{ label: string, sub: string } & ({ type: 'workspace', ws: Workspace } | { type: 'folder', dir: string }
 *   | { type: 'ssh', profile: SessionProfile } | { type: 'closed', entry: HistoryEntry })} Place
 */
/**
 * A "Go to" row: a place, scored, with its label's matched characters; or the row that makes a new workspace.
 * @typedef {{ kind: 'go', positions: number[], score?: number }
 *   & (Place | { type: 'new', label: string, sub: string })} GoResult
 */
/**
 * A row the palette shows.
 * @typedef {OpenResult | ClosedResult | WorkspaceResult | CommandResult | RanResult | GoResult} PaletteResult
 */

const layer = byId('palette-layer');
const input = /** @type {HTMLInputElement} */ (byId('pal-input'));
const filtersEl = byId('pal-filters');
const resultsEl = byId('pal-results');
const previewEl = byId('pal-preview');

/** The kinds of result, in the order the palette lists their groups. */
const KIND = Object.freeze({ open: 'open', closed: 'closed', workspaces: 'workspaces', commands: 'commands', go: 'go', ran: 'ran' });
/** The palette's views (its filter chips): everything, or one kind of result. */
export const PALETTE_VIEW = Object.freeze({ all: 'all', ...KIND });
/** The kinds of place "Go to" offers, and its row that makes a new workspace. */
const PLACE = Object.freeze({ workspace: 'workspace', folder: 'folder', ssh: 'ssh', closed: 'closed', new: 'new' });
/** What a terminal's search matched on, and how that ranks (lower is better; with no text, all rank the same). */
const MATCHED_ON = Object.freeze({ name: 'name', tag: 'tag', note: 'note', workspace: 'workspace', output: 'output' });
const RANK = Object.freeze({ name: 0, tag: 1, note: 1.5, workspace: 2, output: 2.5, noText: 3 });
/** Added to the rank of a terminal in a workspace other than the active one. */
const OTHER_WORKSPACE_RANK = 0.1;
/** The preview's buttons, by their data-act. */
const ACT = Object.freeze({ go: 'go', copy: 'copy', forget: 'forget' });
/** The command history's narrowing words: how a command ended, and the folder it ran in ("in:<folder text>"). */
const FAILED_WORDS = ['failed', 'fail'];
const OK_WORDS = ['ok', 'succeeded'];
const IN_FOLDER = 'in:';
/** A result's row. */
const RESULT_ROW = '.res';
/** An open terminal's state, in its row and preview. */
const RUNNING_LABEL = 'running';
/** How many output lines the preview shows, and how many of them come before the matching one. */
const PREVIEW_LINES = 22;
const PREVIEW_BEFORE = 9;
/** How many rows above a match the terminal scrolls to, so the match shows with some context. */
const SCROLL_CONTEXT_ROWS = 3;

const FILTERS = [
  [PALETTE_VIEW.all, 'All'], [PALETTE_VIEW.open, 'Open'], [PALETTE_VIEW.closed, 'Recently closed'],
  [PALETTE_VIEW.workspaces, 'Workspaces'], [PALETTE_VIEW.commands, 'Commands'], [PALETTE_VIEW.ran, 'Command history'],
  [PALETTE_VIEW.go, 'Go to'],
];
/** @type {Record<string, string>} */
const GROUP_TITLES = { open: 'Open terminals', closed: 'Recently closed', workspaces: 'Workspaces', commands: 'Commands', go: 'Go to', ran: 'Commands run' };
/** @type {Record<string, number>} */
const LIMITS = { open: 40, closed: 40, workspaces: 12, commands: 12, go: 60, ran: 200 };

/** @type {string} */
let filter = PALETTE_VIEW.all;
/** @type {PaletteResult[]} */
let results = [];
let selected = 0;
/** @type {HistoryEntry[]} */
let history = [];
let historyStale = true;
/** @type {Map<string, Lines>} */
let lineCache = new Map(); // tab id -> lines, captured when the palette opens
/** @type {() => PaletteCommand[]} */
let commands = () => [];

/**
 * Supplies the app commands the palette can run: [{ label, hint, keywords, run }].
 * @param {() => PaletteCommand[]} fn
 */
export function setCommands(fn) {
  commands = fn;
}

/**
 * Commands run in terminals (CommandHistory.cs), newest first; asked for when the "Command history" view opens.
 * @type {RanEntry[]}
 */
let ranHistory = [];
onHost(HOST.historyCommands, m => {
  ranHistory = Array.isArray(m.entries) ? m.entries : [];
  if (!layer.hidden && filter === PALETTE_VIEW.ran) run();
});

on(EVENTS.history, () => { historyStale = true; });
onHost(HOST.history, m => {
  history = Array.isArray(m.entries) ? m.entries : [];
  historyStale = false;
  if (!layer.hidden) run();
});

export const isPaletteOpen = () => !layer.hidden;

/** Opens the palette on the "Go to" picker (Ctrl+Shift+O). */
export const openGoTo = () => openPalette({ filter: PALETTE_VIEW.go });
/** Opens the palette on the command history (Ctrl+Shift+H). */
export const openCommandHistory = () => openPalette({ filter: PALETTE_VIEW.ran });

/** @param {{ filter?: string, query?: string }} [options] */
export function openPalette({ filter: initialFilter = PALETTE_VIEW.all, query = '' } = {}) {
  closeAll();
  filter = initialFilter;
  input.value = query;
  lineCache = new Map([...state.tabs.values()].map(t => [t.id, bufferLines(t)]));
  layer.hidden = false;
  if (historyStale) send(PAGE.historyList);
  send(PAGE.historyCommands);
  run();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}

export function closePalette() {
  if (layer.hidden) return;
  layer.hidden = true;
  lineCache = new Map();
  restoreFocus();
}

// ---- Query and matching ----

/**
 * Splits "tag:prod ws:infra migrat" into filters and free text (all lower-case).
 * @param {string} text
 */
function parseQuery(text) {
  /** @type {Query} */
  const q = { text: '', tag: null, ws: null, shell: null };
  const free = [];
  for (const token of text.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    const m = /^(tag|ws|shell):(.*)$/.exec(token);
    if (m) q[/** @type {'tag' | 'ws' | 'shell'} */ (m[1])] = m[2];
    else free.push(token);
  }
  q.text = free.join(' ');
  return q;
}

/**
 * Every matching line (indexes, oldest first).
 * @param {string[]} lines
 * @param {string} text
 */
function matchLines(lines, text) {
  /** @type {number[]} */
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(text)) hits.push(i);
  }
  return hits;
}

/**
 * @param {Query} q
 * @param {{ tags: string[], wsName: string | null | undefined, shell: string[] }} source
 */
function passesFilters(q, { tags, wsName, shell }) {
  if (q.tag && !tags.some(t => t.includes(/** @type {string} */ (q.tag)))) return false;
  if (q.ws && !(wsName ?? '').toLowerCase().includes(q.ws)) return false;
  if (q.shell && !shell.some(s => s.toLowerCase().includes(/** @type {string} */ (q.shell)))) return false;
  return true;
}

/**
 * How a source matched, ranked (lower is better): name, then tag, then workspace, then output only.
 * Output matches are always looked up, so a result found by name can still show its matching lines. It starts on
 * the newest one (the output just seen, not the prompt the shell printed when it started); the preview steps through them.
 * @param {Query} q
 * @param {{ title: string, tags: string[], wsName: string | null | undefined, lines: string[],
 *   note: string | null | undefined }} source
 * @returns {TextMatch | null}
 */
function textMatch(q, { title, tags, wsName, lines, note }) {
  if (!q.text) return { rank: RANK.noText };
  const hits = lines?.length ? matchLines(lines, q.text) : [];
  const hit = /** @type {OutputHit | NoHit} */ (hits.length
    ? { hits, at: hits.length - 1, line: hits[hits.length - 1], count: hits.length, inOutput: true }
    : {});
  if (title.toLowerCase().includes(q.text)) return { rank: RANK.name, on: MATCHED_ON.name, ...hit };
  if (tags.some(t => t.includes(q.text))) return { rank: RANK.tag, on: MATCHED_ON.tag, ...hit };
  if ((note ?? '').toLowerCase().includes(q.text)) return { rank: RANK.note, on: MATCHED_ON.note, ...hit };
  if ((wsName ?? '').toLowerCase().includes(q.text)) return { rank: RANK.workspace, on: MATCHED_ON.workspace, ...hit };
  if (hit.inOutput) return { rank: RANK.output, on: MATCHED_ON.output, ...hit };
  return null;
}

// ---- "Go to": workspaces, recent folders, closed sessions and SSH hosts in one fuzzy list ----

const FOLDER_ICON = '<svg viewBox="0 0 16 16"><path d="M2 4.5A1.5 1.5 0 0 1 3.5 3h3l1.5 1.5h4.5A1.5 1.5 0 0 1 14 6v5.5a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z"/></svg>';
/** Ties go to the kind of place people jump to most. */
const TYPE_BONUS = { workspace: 1.5, folder: 1, ssh: 0.5, closed: 0 };
/** @param {string} dir */
const basename = dir => dir.split(/[\\/]/).filter(Boolean).pop() ?? dir;

/** @param {string} text */
function goPlaces(text) {
  /** @type {Place[]} */
  const places = [];
  for (const ws of state.workspaces) {
    const n = tabsOf(ws).length;
    places.push({ type: PLACE.workspace, label: ws.name, sub: ws.cwd ?? `${n} terminal${n === 1 ? '' : 's'}`, ws });
  }
  const open = new Set(state.workspaces.map(w => (w.cwd ?? '').toLowerCase()));
  for (const dir of state.recentDirs) {
    if (!open.has(dir.toLowerCase())) places.push({ type: PLACE.folder, label: basename(dir), sub: dir, dir });
  }
  for (const profile of state.profiles.filter(p => isSshProfile(p))) {
    places.push({ type: PLACE.ssh, label: profile.name, sub: `SSH · ${profile.description}`, profile });
  }
  for (const entry of history) {
    places.push({ type: PLACE.closed, label: entry.name ?? DEFAULT_TAB_TITLE, sub: `closed ${formatWhen(entry.closedAt)} · ${entry.wsName ?? ''}`, entry });
  }

  /** @type {GoResult[]} */
  const scored = [];
  for (const place of places) {
    const byLabel = fuzzyMatch(text, place.label);
    const bySub = byLabel ? null : fuzzyMatch(text, place.sub);
    const m = byLabel ?? bySub;
    if (!m) continue;
    scored.push({ kind: KIND.go, ...place, positions: byLabel?.positions ?? [], score: m.score + (byLabel ? 2 : 0) + TYPE_BONUS[place.type] });
  }
  if (text.trim()) scored.sort((a, b) => /** @type {number} */ (b.score) - /** @type {number} */ (a.score));
  scored.push({ kind: KIND.go, type: PLACE.new, label: 'New workspace from folder', sub: 'Pick a folder; the workspace takes its name', positions: [] });
  return scored;
}

// ---- "Command history": every command a terminal with shell integration ran ----

/** Narrowing words for the command history: "failed" (or "ok"), "in:<folder text>"; the rest matches the command.
 * @param {string} text
 */
function ranQuery(text) {
  /** @type {{ words: string[], failed: boolean | null, in: string | null }} */
  const q = { words: [], failed: null, in: null };
  for (const token of text.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    if (FAILED_WORDS.includes(token)) q.failed = true;
    else if (OK_WORDS.includes(token)) q.failed = false;
    else if (token.startsWith(IN_FOLDER)) q.in = token.slice(IN_FOLDER.length);
    else q.words.push(token);
  }
  return q;
}

/**
 * @param {string} text
 * @returns {RanResult[]}
 */
function ranResults(text) {
  const q = ranQuery(text);
  return ranHistory.filter(e => {
    const failed = e.exitCode !== null && e.exitCode !== undefined && e.exitCode !== 0;
    if (q.failed !== null && failed !== q.failed) return false;
    if (q.in && !(e.cwd ?? '').toLowerCase().includes(q.in)) return false;
    const hay = (e.command ?? '').toLowerCase();
    return q.words.every(w => hay.includes(w));
  }).map(entry => ({ kind: KIND.ran, entry, words: q.words }));
}

/** @param {RanEntry} e */
function ranDetail(e) {
  return [
    e.exitCode === null || e.exitCode === undefined ? 'exit ?' : `exit ${e.exitCode}`,
    typeof e.durationMs === 'number' ? formatDuration(e.durationMs) : '',
    e.cwd ?? '',
    [e.terminal, e.workspace].filter(Boolean).join(' · '),
    e.host ? `on ${e.host}` : '', // synced from another PC
  ].filter(Boolean).join('  ·  ');
}

/**
 * Puts a command at the prompt of the focused terminal, without running it.
 * @param {string} command
 */
function insertCommand(command) {
  const tab = focusedTab();
  if (!tab) return;
  send(PAGE.input, { id: tab.id, data: command.replace(/\r?\n/g, '\r') });
  focusTab(tab);
}

/**
 * The open terminals a query finds (in their names, tags, workspace, output and notes); the active workspace's first.
 * @param {Query} q
 * @returns {OpenResult[]}
 */
function openMatches(q) {
  /** @type {OpenResult[]} */
  const found = [];
  for (const ws of state.workspaces) {
    for (const tab of tabsOf(ws)) {
      const profile = profileOf(tab);
      const lines = lineCache.get(tab.id) ?? [];
      if (!passesFilters(q, { tags: tab.tags, wsName: ws.name, shell: [profile?.name ?? '', profile?.icon ?? ''] })) continue;
      const m = textMatch(q, { title: tabTitle(tab), tags: tab.tags, wsName: ws.name, lines, note: notesFor(tab).map(n => n.text).join('\n') });
      if (m) found.push({ kind: KIND.open, tab, ws, lines, match: m, rank: m.rank + (ws.id === state.activeId ? 0 : OTHER_WORKSPACE_RANK) });
    }
  }
  return found;
}

/**
 * The closed terminals in history a query finds.
 * @param {Query} q
 * @returns {ClosedResult[]}
 */
function closedMatches(q) {
  /** @type {ClosedResult[]} */
  const found = [];
  for (const entry of history) {
    const profile = state.profiles.find(p => p.id === entry.profile);
    const lines = entry.lines ?? [];
    if (!passesFilters(q, { tags: entry.tags ?? [], wsName: entry.wsName, shell: [profile?.name ?? '', profile?.icon ?? ''] })) continue;
    const m = textMatch(q, { title: entry.name ?? '', tags: entry.tags ?? [], wsName: entry.wsName, lines, note: entry.note?.text });
    if (m) found.push({ kind: KIND.closed, entry, profile, lines, match: m, rank: m.rank });
  }
  return found;
}

/** @returns {{ q: Query, groups: Record<string, PaletteResult[]> }} */
function search() {
  if (filter === PALETTE_VIEW.go) return { q: parseQuery(''), groups: { go: goPlaces(input.value) } };
  if (filter === PALETTE_VIEW.ran) return { q: parseQuery(''), groups: { ran: ranResults(input.value) } };
  const q = parseQuery(input.value);
  /**
   * @type {{ open: OpenResult[], closed: ClosedResult[], workspaces: WorkspaceResult[],
   *   commands: CommandResult[] }}
   */
  const groups = { open: [], closed: [], workspaces: [], commands: [] };
  /** @param {string} kind */
  const want = kind => filter === PALETTE_VIEW.all || filter === kind;

  if (want(KIND.open)) groups.open = openMatches(q);
  if (want(KIND.closed)) groups.closed = closedMatches(q);

  const hasFilter = q.tag || q.ws || q.shell;
  if (want(KIND.workspaces) && !hasFilter) {
    for (const ws of state.workspaces) {
      if (!q.text || ws.name.toLowerCase().includes(q.text) || (ws.note?.text ?? '').toLowerCase().includes(q.text)) groups.workspaces.push({ kind: KIND.workspaces, ws });
    }
  }

  if (want(KIND.commands) && !hasFilter && (q.text || filter === PALETTE_VIEW.commands)) {
    for (const cmd of commands()) {
      const hay = `${cmd.label} ${cmd.keywords ?? ''}`.toLowerCase();
      if (!q.text || q.text.split(' ').every(word => hay.includes(word))) groups.commands.push({ kind: KIND.commands, cmd });
    }
  }

  // Better matches first; ties keep their natural order (workspace order, newest closed first).
  groups.open.sort((a, b) => a.rank - b.rank);
  groups.closed.sort((a, b) => a.rank - b.rank);
  return { q, groups };
}

// ---- Rendering ----

/**
 * A result's row around its parts, picked when it's the selected one.
 * @param {number} index
 * @param {string} inner
 */
const resultRow = (index, inner) => `<div class="res${index === selected ? ' sel' : ''}" data-index="${index}" role="option">
      ${inner}
    </div>`;

/**
 * A workspace's tile: its first letter in its colour.
 * @param {Workspace} ws
 */
const wsTile = ws => `<span class="ws-tile" style="--c:${ws.color}">${escapeHtml([...ws.name][0]?.toUpperCase() ?? '?')}</span>`;

/** An open or closed terminal: its name, tags and workspace, and a line of its output when the search found one there.
 * @param {OpenResult | ClosedResult} r
 * @param {Query} q
 */
function terminalRowHtml(r, q) {
  const isOpen = r.kind === KIND.open;
  const title = isOpen ? tabTitle(r.tab) : r.entry.name;
  const tags = isOpen ? r.tab.tags : r.entry.tags ?? [];
  const wsName = isOpen ? r.ws.name : r.entry.wsName;
  const profile = isOpen ? profileOf(r.tab) : r.profile;
  const detail = r.match.inOutput
    ? snippet(r.lines[r.match.line], q.text)
    : r.match.on ? `matched ${r.match.on}` : isOpen ? escapeHtml(profile?.name ?? '') : r.entry.noHistory ? 'output not kept' : `${r.lines.length} lines kept`;
  const right = isOpen
    ? `<span class="state">${RUNNING_LABEL}</span>${r.match.count ? `${r.match.count} match${r.match.count === 1 ? '' : 'es'}` : ''}`
    : `<span class="state closed">closed</span>${escapeHtml(formatWhen(r.entry.closedAt))}`;
  return `${badgeHtml(profile, BADGE_SIZE.large)}
      <div class="res-main">
        <div class="res-line1"><span class="res-title">${highlight(title, r.match.on === MATCHED_ON.name ? q.text : '')}</span>
          ${tags.slice(0, 3).map(t => tagChipHtml(t, { mini: true })).join('')}
          <span class="res-where">· ${escapeHtml(wsName ?? '')}</span></div>
        <div class="res-line2">${detail}</div>
      </div>
      <div class="res-right">${right}</div>`;
}

/**
 * A command from the history: how it ended, where and when it ran.
 * @param {RanResult} r
 */
function ranRowHtml(r) {
  const e = r.entry;
  const failed = e.exitCode !== null && e.exitCode !== undefined && e.exitCode !== 0;
  return `<span class="ran-mark ${failed ? 'fail' : 'ok'}"></span>
      <div class="res-main"><div class="res-line1"><span class="res-title mono">${highlight(e.command ?? '', r.words[0] ?? '')}</span></div>
        <div class="res-line2">${escapeHtml(ranDetail(e))}</div></div>
      <div class="res-right"><span class="state${failed ? ' closed' : ''}">${failed ? 'failed' : 'ok'}</span>${escapeHtml(formatWhen(e.at))}</div>`;
}

/** A place "Go to" offers: a workspace, a folder, a closed terminal, an SSH host, or a new workspace.
 * @param {GoResult} r
 */
function goRowHtml(r) {
  const icon = r.type === PLACE.workspace ? wsTile(r.ws)
    : r.type === PLACE.folder || r.type === PLACE.new ? `<span class="cmd-icon">${r.type === PLACE.new ? ICONS.plus : FOLDER_ICON}</span>`
    : r.type === PLACE.ssh ? badgeHtml(r.profile, BADGE_SIZE.large)
    : badgeHtml(state.profiles.find(p => p.id === r.entry.profile), BADGE_SIZE.large);
  return `${icon}
      <div class="res-main"><div class="res-line1"><span class="res-title">${highlightPositions(r.label, r.positions, escapeHtml)}</span></div>
        <div class="res-line2">${escapeHtml(r.sub)}</div></div>
      <div class="res-right">${r.type === 'new' ? '' : `<span class="state${r.type === 'closed' ? ' closed' : ''}">${r.type}</span>`}</div>`;
}

/**
 * @param {WorkspaceResult} r
 * @param {Query} q
 */
function workspaceRowHtml(r, q) {
  const n = tabsOf(r.ws).length;
  return `${wsTile(r.ws)}
      <div class="res-main"><div class="res-line1"><span class="res-title">${highlight(r.ws.name, q.text)}</span></div>
        <div class="res-line2">${n} terminal${n === 1 ? '' : 's'}${r.ws.id === state.activeId ? ' · current' : ''}</div></div>`;
}

/**
 * @param {CommandResult} r
 * @param {Query} q
 */
const commandRowHtml = (r, q) => `<span class="cmd-icon">${r.cmd.icon ?? ICONS.plus}</span>
    <div class="res-main"><div class="res-line1"><span class="res-title">${highlight(r.cmd.label, q.text)}</span></div></div>
    <div class="res-right">${r.cmd.hint ?? ''}</div>`;

/**
 * Draws one kind of result. Each gets the kind of result it's listed for, so the table holds them as taking any.
 * @typedef {(r: any, q: Query) => string} RowHtml
 */
/**
 * How each kind of result is drawn; anything else is a command.
 * @type {Record<string, RowHtml>}
 */
const ROW_HTML = { open: terminalRowHtml, closed: terminalRowHtml, ran: ranRowHtml, go: goRowHtml, workspaces: workspaceRowHtml };

/**
 * @param {PaletteResult} r
 * @param {number} index
 * @param {Query} q
 */
const rowHtml = (r, index, q) => resultRow(index, (ROW_HTML[r.kind] ?? /** @type {RowHtml} */ (commandRowHtml))(r, q));

/** @type {Record<string, string>} */
const PLACEHOLDERS = {
  go: 'Go to a workspace, folder, closed terminal or SSH host',
  ran: 'Search commands you ran · failed · in:folder',
  default: 'Search terminals, closed sessions, output and commands',
};

function run() {
  input.placeholder = PLACEHOLDERS[filter] ?? PLACEHOLDERS.default;
  const { q, groups } = search();
  results = [];
  let html = '';
  for (const kind of Object.values(KIND)) {
    const list = groups[kind] ?? [];
    if (!list.length) continue;
    const shown = list.slice(0, LIMITS[kind]);
    html += `<div class="res-group">${GROUP_TITLES[kind]}<span>${list.length}</span></div>`;
    for (const r of shown) {
      html += rowHtml(r, results.length, q);
      results.push(r);
    }
  }
  if (!results.length) {
    html = `<div class="res-empty">${input.value.trim() ? 'Nothing matches' : 'Nothing here yet'}</div>`;
  }
  selected = Math.min(selected, Math.max(0, results.length - 1));
  resultsEl.innerHTML = html;
  markSelected();

  /** @type {Record<string, number>} */
  const counts = { [PALETTE_VIEW.all]: 0 };
  for (const [kind, list] of Object.entries(groups)) counts[kind] = list.length;
  counts.all = Object.values(groups).reduce((n, list) => n + list.length, 0);
  filtersEl.innerHTML = FILTERS.map(([id, label]) =>
    `<button class="fchip${id === filter ? ' on' : ''}" data-filter="${id}">${label}${id === filter || counts[id] ? ` <span>${counts[id] ?? 0}</span>` : ''}</button>`).join('');
  renderPreview(q);
}

function markSelected() {
  for (const el of /** @type {NodeListOf<HTMLElement>} */ (resultsEl.querySelectorAll(RESULT_ROW))) {
    el.classList.toggle('sel', Number(el.dataset.index) === selected);
  }
  resultsEl.querySelector('.res.sel')?.scrollIntoView({ block: 'nearest' });
}

/** @param {Query} [q] */
function renderPreview(q = parseQuery(input.value)) {
  const r = results[selected];
  if (!r) {
    previewEl.innerHTML = '<div class="pv-empty">Type to search names, tags, folders and output.<br>Narrow with <code>tag:</code> <code>ws:</code> <code>shell:</code></div>';
    return;
  }
  if (r.kind === KIND.open || r.kind === KIND.closed) {
    const isOpen = r.kind === KIND.open;
    const title = isOpen ? tabTitle(r.tab) : r.entry.name;
    const tags = isOpen ? r.tab.tags : r.entry.tags ?? [];
    const profile = isOpen ? profileOf(r.tab) : r.profile;
    const meta = [
      `Workspace <b>${escapeHtml(isOpen ? r.ws.name : r.entry.wsName ?? '?')}</b>`,
      escapeHtml(profile?.name ?? ''),
      isOpen ? RUNNING_LABEL : `closed ${escapeHtml(formatWhen(r.entry.closedAt))}`,
      r.match.count === 1 ? '1 matching line' : '',
    ].filter(Boolean).join('<span class="dot-sep">·</span>');
    const stepper = /** @type {number} */ (r.match.count) > 1 ? `<span class="pv-step">
        <button class="pv-step-btn" data-step="-1" title="Older match">${ICONS.chevronLeft}</button>
        <span>match ${/** @type {number} */ (r.match.at) + 1} of ${r.match.count}</span>
        <button class="pv-step-btn" data-step="1" title="Newer match">${ICONS.chevronRight}</button></span>` : '';

    let body;
    if (!isOpen && r.entry.noHistory) {
      body = '<div class="pv-note">Output wasn\'t kept for this session.</div>';
    } else if (!r.lines.length) {
      body = '<div class="pv-note">No output yet.</div>';
    } else {
      const center = r.match.inOutput ? r.match.line : r.lines.length - 1;
      const from = Math.max(0, center - PREVIEW_BEFORE);
      const to = Math.min(r.lines.length, from + PREVIEW_LINES);
      body = `<pre class="pv-term">${r.lines.slice(from, to).map((line, i) =>
        `<span class="pv-line${from + i === r.match.line ? ' hit' : ''}">${highlight(line, r.match.inOutput ? q.text : '') || ' '}</span>`).join('')}</pre>`;
    }
    previewEl.innerHTML = `
      <div class="pv-head"><div class="pv-title">${badgeHtml(profile)}${escapeHtml(title)} ${tags.map(t => tagChipHtml(t)).join('')}</div>
        <div class="pv-meta">${meta}${stepper}</div></div>
      ${body}
      <div class="pv-actions">
        <button class="btn primary" data-act="go">${isOpen ? 'Go to terminal' : 'Reopen'} <kbd>Enter</kbd></button>
        ${isOpen ? '' : '<button class="btn" data-act="forget">Remove from history</button>'}
      </div>`;
    return;
  }
  if (r.kind === KIND.ran) {
    const e = r.entry;
    previewEl.innerHTML = `
      <div class="pv-head"><div class="pv-title mono">${escapeHtml(e.command)}</div>
        <div class="pv-meta">${escapeHtml(ranDetail(e))}<span class="dot-sep">·</span>${escapeHtml(formatWhen(e.at))}</div></div>
      <div class="pv-actions"><button class="btn primary" data-act="go">Put at the prompt <kbd>Enter</kbd></button>
        <button class="btn" data-act="copy">Copy</button></div>`;
    return;
  }
  if (r.kind === KIND.go) {
    const action = { workspace: 'Switch to workspace', folder: 'Open as a workspace', ssh: 'Connect in a new terminal', closed: 'Reopen', new: 'Choose a folder' }[r.type];
    const note = r.type === PLACE.folder ? 'Opens a new workspace here, named after the folder.'
      : r.type === PLACE.ssh ? 'Opens in the current workspace.'
      : r.type === PLACE.closed ? 'Same shell, name and tags, with its saved output.' : '';
    previewEl.innerHTML = `
      <div class="pv-head"><div class="pv-title">${escapeHtml(r.label)}</div><div class="pv-meta">${escapeHtml(r.sub)}</div></div>
      ${note ? `<div class="pv-note">${note}</div>` : ''}
      <div class="pv-actions"><button class="btn primary" data-act="go">${action} <kbd>Enter</kbd></button>
        ${r.type === PLACE.closed ? '<button class="btn" data-act="forget">Remove from history</button>' : ''}</div>`;
    return;
  }
  if (r.kind === KIND.workspaces) {
    const tabs = tabsOf(r.ws);
    previewEl.innerHTML = `
      <div class="pv-head"><div class="pv-title"><span class="ws-tile" style="--c:${r.ws.color}">${escapeHtml([...r.ws.name][0]?.toUpperCase() ?? '?')}</span>${escapeHtml(r.ws.name)}</div>
        <div class="pv-meta">${tabs.length} terminal${tabs.length === 1 ? '' : 's'}${r.ws.cwd ? `<span class="dot-sep">·</span>${escapeHtml(r.ws.cwd)}` : ''}</div></div>
      <div class="pv-list">${tabs.map(t => `<div class="pv-tab">${tabBadgeHtml(t)}${escapeHtml(tabTitle(t))} ${t.tags.map(x => tagChipHtml(x, { mini: true })).join('')}</div>`).join('') || '<div class="pv-note">No terminals</div>'}</div>
      <div class="pv-actions"><button class="btn primary" data-act="go">Switch to workspace <kbd>Enter</kbd></button></div>`;
    return;
  }
  previewEl.innerHTML = `
    <div class="pv-head"><div class="pv-title">${escapeHtml(r.cmd.label)}</div>${r.cmd.hint ? `<div class="pv-meta">${r.cmd.hint}</div>` : ''}</div>
    <div class="pv-actions"><button class="btn primary" data-act="go">Run <kbd>Enter</kbd></button></div>`;
}

// ---- Actions ----

/** @param {PaletteResult} [r] */
function activate(r = results[selected]) {
  if (!r) return;
  closePalette();
  if (r.kind === KIND.open) {
    focusTab(r.tab);
    if (r.match.inOutput) showMatch(r.tab, r.lines, r.match.line, input.value);
  } else if (r.kind === KIND.closed) {
    reopen(r.entry);
  } else if (r.kind === KIND.workspaces) {
    switchWorkspace(r.ws.id);
  } else if (r.kind === KIND.go) {
    goTo(r);
  } else if (r.kind === KIND.ran) {
    insertCommand(r.entry.command);
  } else {
    r.cmd.run();
  }
}

/** Moves the selected result to its older (-1) or newer (1) matching line in the output, wrapping around.
 * @param {number} by
 */
function stepMatch(by) {
  // Only terminals have matches; for any other row match is missing and this returns.
  const r = /** @type {OpenResult | ClosedResult | undefined} */ (results[selected]);
  const m = r?.match;
  if (!m?.hits || m.hits.length < 2) return;
  m.at = (m.at + by + m.hits.length) % m.hits.length;
  m.line = m.hits[m.at];
  const row = resultsEl.querySelector(`.res[data-index="${selected}"] .res-line2`);
  const q = parseQuery(input.value);
  if (row) row.innerHTML = snippet(/** @type {OpenResult | ClosedResult} */ (r).lines[m.line], q.text);
  renderPreview(q);
}

/**
 * Scrolls an open terminal to a matching line and selects the match in it.
 * @param {Tab} tab
 * @param {Lines} lines
 * @param {number} line
 * @param {string} query
 */
function showMatch(tab, lines, line, query) {
  const term = tab.view?.term;
  const row = lines.rows?.[line];
  if (!term || row === undefined) return;
  term.scrollToLine(Math.max(0, row - SCROLL_CONTEXT_ROWS));
  const text = parseQuery(query).text;
  const col = text ? lines[line].toLowerCase().indexOf(text) : -1;
  if (col >= 0) term.select(col % term.cols, row + Math.floor(col / term.cols), text.length);
}

/**
 * Acts on a "Go to" place.
 * @param {GoResult} place
 */
async function goTo(place) {
  if (place.type === PLACE.workspace) switchWorkspace(place.ws.id);
  else if (place.type === PLACE.closed) reopen(place.entry);
  else if (place.type === PLACE.ssh) newTab({ wsId: ensureActiveWorkspace().id, profile: place.profile.id });
  else if (place.type === PLACE.folder) openFolder(place.dir);
  else if (place.type === PLACE.new) {
    const dir = await pickFolder(state.recentDirs[0] ?? null);
    if (dir) openFolder(dir);
  }
}

/** Switches to the workspace for a folder, or opens a new one there named after it (with its layout, if it has one).
 * @param {string} dir
 */
async function openFolder(dir) {
  const existing = state.workspaces.find(w => (w.cwd ?? '').toLowerCase() === dir.toLowerCase());
  if (existing) {
    switchWorkspace(existing.id);
    return;
  }
  const found = await probeFolder(dir);
  if (found && await offerLayout(found)) applyLayout({ ...found.layout, name: found.layout.name ?? basename(dir), cwd: found.layout.cwd ?? dir }, { warnings: found.warnings });
  else createWorkspace({ name: freeName(basename(dir)), cwd: dir });
}

/** Reopens a closed session: same shell, name and tags, in its workspace if it still exists, with the
 *  saved output shown above the new prompt. The history entry is used up.
 * @param {HistoryEntry} entry
 */
function reopen(entry) {
  for (const tag of entry.tags ?? []) ensureTag(tag);
  const ws = wsById(entry.wsId) ?? ensureActiveWorkspace();
  if (ws.id !== state.activeId) switchWorkspace(ws.id);
  newTab({
    wsId: ws.id,
    profile: entry.profile,
    name: entry.customName ?? null,
    tags: entry.tags ?? [],
    note: entry.note ?? null,
    restore: entry.lines?.length ? { lines: entry.lines, closedAt: entry.closedAt } : undefined,
  });
  forget(entry);
}

/** @param {HistoryEntry} entry */
function forget(entry) {
  send(PAGE.historyDelete, { id: entry.id });
  history = history.filter(e => e.id !== entry.id);
}

// ---- Events ----

input.addEventListener('input', () => {
  selected = 0;
  run();
});

input.addEventListener('keydown', e => {
  e.stopPropagation(); // keep app shortcuts out while typing
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (!results.length) return;
    selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
    markSelected();
    renderPreview();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    activate();
  } else if (e.key === 'Escape') {
    e.preventDefault();
    closePalette();
  } else if (e.key === 'Tab') {
    e.preventDefault();
    const i = FILTERS.findIndex(([id]) => id === filter);
    filter = FILTERS[(i + (e.shiftKey ? -1 : 1) + FILTERS.length) % FILTERS.length][0];
    selected = 0;
    run();
  }
});

filtersEl.addEventListener('mousedown', e => e.preventDefault()); // keep focus in the input
filtersEl.addEventListener('click', e => {
  const chip = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-filter]'));
  if (chip) filter = /** @type {string} */ (chip.dataset.filter);
  else return;
  selected = 0;
  run();
});

resultsEl.addEventListener('mousedown', e => e.preventDefault());
resultsEl.addEventListener('mousemove', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(RESULT_ROW));
  if (!row || Number(row.dataset.index) === selected) return;
  selected = Number(row.dataset.index);
  markSelected();
  renderPreview();
});
resultsEl.addEventListener('click', e => {
  const row = /** @type {HTMLElement | null} */ (targetOf(e).closest(RESULT_ROW));
  if (row) activate(results[Number(row.dataset.index)]);
});

previewEl.addEventListener('mousedown', e => {
  if (targetOf(e).closest('button')) e.preventDefault();
});
previewEl.addEventListener('click', e => {
  const step = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-step]'))?.dataset.step;
  if (step) stepMatch(Number(step));
  const act = /** @type {HTMLElement | null} */ (targetOf(e).closest('[data-act]'))?.dataset.act;
  if (act === ACT.go) activate();
  else if (act === ACT.copy && results[selected]?.kind === KIND.ran) {
    navigator.clipboard.writeText(/** @type {RanResult} */ (results[selected]).entry.command);
    input.focus();
  }
  else if (act === ACT.forget) {
    forget(/** @type {{ entry: HistoryEntry }} */ (results[selected]).entry); // a closed terminal, or one in Go to
    run();
    input.focus();
  }
});

layer.addEventListener('mousedown', e => {
  if (e.target === layer) closePalette();
});
