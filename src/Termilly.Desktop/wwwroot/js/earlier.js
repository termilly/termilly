// @ts-check
// A terminal's earlier output (EarlierOutput.cs on the host): the lines that leave its scrollback, kept so search
// still finds them. They leave two ways: the scrollback is full and its oldest rows drop off the top, or a program
// wipes it (cls; Claude Code wipes and draws itself again whenever the terminal's size changes, a phone showing it
// included, and when it compacts or resumes). The rows go to the host just before either.
// What a program draws again after a wipe is mostly kept already: runs of lines found in what's kept are left out.
// They're compared by pieces of their text without the spaces, so a redraw at another width, wrapped differently,
// still counts as the same; a short line that comes again is real output and stays.

import { send, request } from './host.js';
import { PAGE } from './protocol.js';
import { state, on, EVENTS } from './store.js';
import { leaveOutRepeats, piecesOf } from './earlierrepeats.js';

/** Rows sent at a time as the scrollback fills, before its top drops them. */
const BATCH = 1000;
/** Erase in Display of the screen (2) and of the scrollback (3): what's there is about to go. */
const ERASES = [2, 3];
/** How many kept lines a terminal starts comparing with (the host's last ones). */
const START_LINES = 5000;

/**
 * Per terminal: the first row not sent yet (a marker, so it stays on its row as the top drops rows), the pieces of
 * what's kept, and the sends in order (the first waits for the pieces).
 * @typedef {{ marker: any, pieces: Set<number> | null, queue: Promise<void> }} Earlier
 */
/** @type {WeakMap<Tab, Earlier>} */
const earlier = new WeakMap();

/**
 * Whether a terminal's output is kept: in a workspace (not the scratch terminal), not opted out, and Settings keeps output.
 * @param {Tab} tab
 */
const keeps = tab => !!tab.wsId && !tab.noHistory && !!state.settings.session.saveOutput;

/**
 * A marker on a row of the normal buffer.
 * @param {any} term
 * @param {number} row
 */
function markAt(term, row) {
  const buffer = term.buffer.normal;
  return term.registerMarker(row - (buffer.baseY + buffer.cursorY));
}

/** @param {Earlier} e */
const firstRow = e => (e.marker && !e.marker.isDisposed ? e.marker.line : 0);

/**
 * Rows from..to as lines: wrapped rows joined into their line (a line going on past `to` is taken whole).
 * @param {any} buffer
 * @param {number} from
 * @param {number} to
 * @returns {{ lines: string[], end: number }}
 */
function rowsOf(buffer, from, to) {
  while (to < buffer.length && buffer.getLine(to)?.isWrapped) to++;
  /** @type {string[]} */
  const lines = [];
  for (let y = from; y < to; y++) {
    const row = buffer.getLine(y);
    if (!row) continue;
    // Untrimmed, so a space at the wrap point survives the join; each line's end is trimmed after.
    const text = row.translateToString(false);
    if (row.isWrapped && lines.length) lines[lines.length - 1] += text;
    else lines.push(text);
  }
  return { lines: lines.map(l => l.trimEnd()), end: to };
}

/**
 * The scrollback is full: its top rows are sent before they drop off. The screen's rows wait (they can still change).
 * @param {Tab} tab
 */
function nearlyFull(tab) {
  const e = earlier.get(tab), term = tab.view?.term;
  if (!e || !term || term.buffer.active.type !== 'normal') return;
  const buffer = term.buffer.normal;
  if (buffer.length < term.rows + term.options.scrollback) return;
  const from = firstRow(e);
  if (from >= BATCH) return;
  const to = Math.min(from + BATCH, buffer.baseY);
  if (to <= from) return;
  const { lines, end } = rowsOf(buffer, from, to);
  e.marker?.dispose();
  e.marker = markAt(term, end);
  keep(tab, e, lines);
}

/**
 * A program wipes the screen or the scrollback: what's there and not sent yet goes now. What's written next starts
 * at the screen's top.
 * @param {Tab} tab
 */
function wiped(tab) {
  const e = earlier.get(tab), term = tab.view?.term;
  if (!e || !term || term.buffer.active.type !== 'normal') return;
  const buffer = term.buffer.normal;
  const { lines } = rowsOf(buffer, firstRow(e), buffer.length);
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  e.marker?.dispose();
  e.marker = markAt(term, buffer.baseY);
  keep(tab, e, lines);
}

/**
 * Sends lines to the host, leaving out what it has already; in order, after the terminal's pieces are known.
 * @param {Tab} tab
 * @param {Earlier} e
 * @param {string[]} lines
 */
function keep(tab, e, lines) {
  if (!lines.length) return;
  e.queue = e.queue.then(async () => {
    if (!keeps(tab)) return;
    if (!e.pieces) e.pieces = await piecesKept(tab);
    const fresh = leaveOutRepeats(lines, e.pieces);
    if (fresh.length) send(PAGE.earlierAdd, { id: tab.id, lines: fresh });
  }).catch(err => console.warn('earlier output', err));
}

/**
 * The pieces of what the host has kept for the terminal already (its last lines): after a restart, what Claude Code
 * draws again is still known.
 * @param {Tab} tab
 * @returns {Promise<Set<number>>}
 */
async function piecesKept(tab) {
  const m = await request(PAGE.earlierTail, { id: tab.id, count: START_LINES });
  const pieces = new Set();
  piecesOf(Array.isArray(m?.lines) ? m.lines : [], (h) => { pieces.add(h); });
  return pieces;
}

on(EVENTS.terminalOpened, tab => {
  const term = tab.view.term;
  earlier.set(tab, { marker: markAt(term, 0), pieces: null, queue: Promise.resolve() });
  term.onLineFeed(() => nearlyFull(tab));
  term.parser.registerCsiHandler({ final: 'J' }, (/** @type {number[]} */ params) => {
    if (ERASES.includes(params[0])) wiped(tab);
    return false; // the terminal still erases
  });
});

/** Earlier output stays for the open terminals and the closed ones in history; the rest goes (at start, after clearing history). */
export const keepEarlierOfOpen = () => send(PAGE.earlierKeep, { ids: [...state.tabs.keys()] });
