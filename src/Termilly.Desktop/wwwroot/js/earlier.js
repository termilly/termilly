// @ts-check
// A terminal's earlier output (EarlierOutput.cs on the host): the lines that leave its scrollback, kept so search
// still finds them. They leave two ways: the scrollback is full and its oldest rows drop off the top, or a program
// wipes it (cls; Claude Code wipes and draws itself again whenever the terminal's size changes, a phone showing it
// included, and when it compacts or resumes). The rows go to the host just before either.
// What a program draws again after a wipe is mostly kept already: long runs of lines that are exactly what's kept
// are left out. They're compared without their spaces, so a redraw at another width, wrapped differently, still
// counts as the same; a line that only resembles one kept, and a short line that comes again, are real output and stay.

import { send, request } from './host.js';
import { PAGE } from './protocol.js';
import { state, on, EVENTS } from './store.js';
import { leaveOutRepeats, keptFrom } from './earlierrepeats.js';

/** Rows sent at a time as the scrollback fills, before its top drops them. */
const BATCH = 1000;
/** Erase in Display of the screen (2) and of the scrollback (3): what's there is about to go. */
const ERASES = [2, 3];
/** How many kept lines a terminal starts comparing with (the host's last ones). */
const START_LINES = 5000;
/** Lines compared at a time, the window getting a turn between (a redraw can bring thousands). */
const SLICE = 300;

/**
 * Per terminal: the first row not sent yet (a marker, so it stays on its row as the top drops rows), what's kept
 * (its text), and the sends in order (the first waits for what's kept).
 * @typedef {{ marker: any, kept: import('./earlierrepeats.js').Kept | null, queue: Promise<void> }} Earlier
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
 * Sends lines to the host, leaving out what it has already; in order, after what the terminal kept is known.
 * @param {Tab} tab
 * @param {Earlier} e
 * @param {string[]} lines
 */
function keep(tab, e, lines) {
  if (!lines.length) return;
  e.queue = e.queue.then(async () => {
    if (!keeps(tab)) return;
    if (!e.kept) e.kept = await keptAlready(tab);
    /** @type {string[]} */
    const fresh = [];
    for (let i = 0; i < lines.length; i += SLICE) {
      fresh.push(...leaveOutRepeats(lines.slice(i, i + SLICE), /** @type {import('./earlierrepeats.js').Kept} */ (e.kept)));
      await new Promise(resolve => setTimeout(resolve));
    }
    if (fresh.length) send(PAGE.earlierAdd, { id: tab.id, lines: fresh });
  }).catch(err => console.warn('earlier output', err));
}

/**
 * What the host has kept for the terminal already (its last lines): after a restart, what Claude Code
 * draws again is still known.
 * @param {Tab} tab
 * @returns {Promise<import('./earlierrepeats.js').Kept>}
 */
async function keptAlready(tab) {
  const m = await request(PAGE.earlierTail, { id: tab.id, count: START_LINES });
  return keptFrom(Array.isArray(m?.lines) ? m.lines : []);
}

on(EVENTS.terminalOpened, tab => {
  const term = tab.view.term;
  earlier.set(tab, { marker: markAt(term, 0), kept: null, queue: Promise.resolve() });
  term.onLineFeed(() => nearlyFull(tab));
  term.parser.registerCsiHandler({ final: 'J' }, (/** @type {number[]} */ params) => {
    if (ERASES.includes(params[0])) wiped(tab);
    return false; // the terminal still erases
  });
});

/** Earlier output stays for the open terminals and the closed ones in history; the rest goes (at start, after clearing history). */
export const keepEarlierOfOpen = () => send(PAGE.earlierKeep, { ids: [...state.tabs.keys()] });
