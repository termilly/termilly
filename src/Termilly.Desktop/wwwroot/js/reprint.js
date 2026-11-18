// @ts-check
// Claude Code wipes its screen and scrollback and draws itself again whenever its terminal's size changes. On Windows
// it does so inside the pseudo console (ConPTY), which passes on only a repaint of the screen, never the wipe, so the
// copy drawn before stayed in the scrollback above the new one, cut off where the screen began: an answer looked
// given twice. Once that repaint is in, the copy goes (reprintcopy.js); everything before it stays.

import { platform, PLATFORM } from './host.js';
import { runningAgent } from './store.js';
import { AGENT_KIND } from './constants.js';
import { staleCopy, withoutCopy, rowAfterCut } from './reprintcopy.js';
import { lineOutput } from './rowtext.js';

/** The repaint is in once the output pauses this long. */
const SETTLE_MS = 300;
/** A repaint that hasn't come this long after the size was told isn't waited for. */
const WAIT_MS = 3000;
/**
 * ConPTY's repaint: the cursor to the top left (CUP, final H), then each row of the screen erased whole (EL 2, final K)
 * and drawn again. xterm's parser tells of them, however the output was cut into chunks.
 */
const CURSOR_TO = 'H';
const ERASE_IN_LINE = 'K';
const WHOLE_LINE = 2;

/**
 * Per terminal, a repaint waited for: where the screen's top was when the size was told (a marker, so it moves with
 * its row), whether the repaint has started and which screen rows it erased, how many chunks of output came, the
 * timer, and what to do just before the rewrite.
 * @typedef {{ marker: any, home: boolean, erased: Set<number>, chunks: number, timer: number, before: () => void }} Waiting
 */
/** @type {WeakMap<Tab, Waiting>} */
const waiting = new WeakMap();
/** The terminals whose parser already tells this module of a repaint. @type {WeakSet<any>} */
const watched = new WeakSet();

/**
 * Call as a terminal's new size goes to its program: when Claude Code runs there under ConPTY, the copy its redraw
 * leaves behind goes once the repaint is in. Any other terminal is left as it is.
 * @param {Tab} tab
 * @param {any} term xterm
 * @param {() => void} before runs just before the rewrite (the terminal keeps quiet about it)
 */
export function sizeTold(tab, term, before) {
  if (platform !== PLATFORM.windows || runningAgent(tab) !== AGENT_KIND.claude) return;
  const buffer = term.buffer.active;
  if (buffer.type !== 'normal') return;
  stopWaiting(tab);
  watchRepaints(tab, term);
  const marker = term.registerMarker(-buffer.cursorY);
  if (!marker) return;
  waiting.set(tab, { marker, home: false, erased: new Set(), chunks: 0, timer: window.setTimeout(() => stopWaiting(tab), WAIT_MS), before });
}

/**
 * Notes, while a repaint is waited for, the cursor going to the top left and each screen row erased whole after it.
 * The handlers only look: xterm still does what the sequences say.
 * @param {Tab} tab
 * @param {any} term
 */
function watchRepaints(tab, term) {
  if (watched.has(term)) return;
  watched.add(term);
  term.parser.registerCsiHandler({ final: CURSOR_TO }, (/** @type {number[]} */ params) => {
    const w = waiting.get(tab);
    if (w && (params[0] || 1) === 1 && (params[1] || 1) === 1) w.home = true;
    return false;
  });
  term.parser.registerCsiHandler({ final: ERASE_IN_LINE }, (/** @type {number[]} */ params) => {
    const w = waiting.get(tab);
    if (w?.home && params[0] === WHOLE_LINE) w.erased.add(term.buffer.active.cursorY);
    return false;
  });
}

/**
 * Call with each chunk of a terminal's output, before it's written: the repaint is taken as done once output pauses,
 * and the rewrite only goes when nothing came after it was planned.
 * @param {Tab} tab
 */
export function outputArrived(tab) {
  const w = waiting.get(tab);
  if (!w) return;
  w.chunks++;
  clearTimeout(w.timer);
  w.timer = window.setTimeout(() => settled(tab), SETTLE_MS);
}

/** @param {Tab} tab */
function stopWaiting(tab) {
  const w = waiting.get(tab);
  if (!w) return;
  waiting.delete(tab);
  clearTimeout(w.timer);
  w.marker.dispose();
}

/**
 * The output paused. Only a repaint of the whole screen is trusted to have redrawn what came before: anything else is
 * left. The rewrite waits for xterm to have taken in all the output, and only goes when nothing came meanwhile, so
 * it's of the terminal as it is.
 * @param {Tab} tab
 */
function settled(tab) {
  const w = waiting.get(tab);
  const term = tab.view?.term;
  if (!w || !term) return;
  if (w.erased.size < term.rows) {
    stopWaiting(tab);
    return;
  }
  const chunks = w.chunks;
  term.write('', () => {
    if (waiting.get(tab) !== w) return;
    if (w.chunks !== chunks) w.timer = window.setTimeout(() => settled(tab), SETTLE_MS);
    else rewrite(tab, term, w);
  });
}

/**
 * @param {Tab} tab
 * @param {any} term
 * @param {Waiting} w
 */
function rewrite(tab, term, w) {
  const top = w.marker.isDisposed ? -1 : w.marker.line;
  stopWaiting(tab);
  const buffer = term.buffer.active;
  // A wrap waiting at the right edge wouldn't survive putting the cursor back: left as it is (rare).
  if (top <= 0 || buffer.type !== 'normal' || buffer.cursorX >= term.cols) return;
  const copy = staleCopy(buffer, top, buffer.baseY);
  if (!copy) return;
  const text = withoutCopy(buffer, term.rows, copy, lineOutput);
  if (!text) return;
  // A view scrolled up stays on what it showed; one at the bottom stays at the bottom.
  const scrolledTo = buffer.viewportY < buffer.baseY ? rowAfterCut(buffer.viewportY, copy) : null;
  w.before();
  term.write(text, () => { if (scrolledTo !== null) term.scrollToLine(scrolledTo); });
}
