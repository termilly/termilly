// @ts-check
// What a user sees, for the end-to-end tests (js/testdriver.js, #98): where something is on screen, whether it's cut
// off, whether what's cut off can be scrolled to, and its font. Measured as drawn, the same on every platform.

/** Overflow values that clip without letting the user scroll there. */
const CLIPS_HARD = new Set(['hidden', 'clip']);
/** Overflow values that clip, but scroll. */
const SCROLLS = new Set(['auto', 'scroll']);
/** Rounding: a box half a pixel past an edge is on it. */
const EDGE = 0.5;

/**
 * A box on screen, in the window's pixels.
 * @typedef {{ x: number, y: number, width: number, height: number }} Box
 */

/** @param {Element} el @returns {Box} */
function boxOf(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/**
 * The two directions, each with its own overflow: a box can hide what's past it sideways and scroll up and down.
 * @type {readonly { start: 'x' | 'y', size: 'width' | 'height', overflow: 'overflowX' | 'overflowY',
 *   scrolled: 'scrollLeft' | 'scrollTop', extent: 'scrollWidth' | 'scrollHeight', border: 'clientLeft' | 'clientTop' }[]}
 */
const AXES = Object.freeze([
  { start: 'x', size: 'width', overflow: 'overflowX', scrolled: 'scrollLeft', extent: 'scrollWidth', border: 'clientLeft' },
  { start: 'y', size: 'height', overflow: 'overflowY', scrolled: 'scrollTop', extent: 'scrollHeight', border: 'clientTop' },
]);

/**
 * The ancestors that clip an element, nearest first, with each direction's overflow.
 * @param {Element} el
 * @returns {{ el: Element, overflow: { x: string, y: string } }[]}
 */
function clippers(el) {
  const found = [];
  for (let at = el.parentElement; at; at = at.parentElement) {
    const style = at.ownerDocument.defaultView?.getComputedStyle(at);
    const overflow = { x: style?.overflowX ?? '', y: style?.overflowY ?? '' };
    if ([overflow.x, overflow.y].some(o => CLIPS_HARD.has(o) || SCROLLS.has(o))) found.push({ el: at, overflow });
  }
  return found;
}

/** Whether box a lies within box b. @param {Box} a @param {Box} b */
const within = (a, b) => a.x >= b.x - EDGE && a.y >= b.y - EDGE && a.x + a.width <= b.x + b.width + EDGE && a.y + a.height <= b.y + b.height + EDGE;

/** The window as a box. @param {Element} el @returns {Box} */
function windowBox(el) {
  const view = /** @type {Window} */ (el.ownerDocument.defaultView);
  return { x: 0, y: 0, width: view.innerWidth, height: view.innerHeight };
}

/**
 * Where an element is on screen, or null when nothing matches.
 * @param {Element | null} el
 */
export const box = el => (el ? boxOf(el) : null);

/**
 * Whether an element is cut off: part of it outside an ancestor that clips it, or outside the window.
 * @param {Element} el
 */
export function clipped(el) {
  const own = boxOf(el);
  return !within(own, windowBox(el)) || clippers(el).some(c => !within(own, boxOf(c.el)));
}

/**
 * Whether all of an element can be seen, scrolling where its ancestors scroll, each direction on its own: nothing cut
 * off where an ancestor doesn't scroll, and where it does, nothing before its start or past how far it scrolls.
 * @param {Element} el
 */
export function reachable(el) {
  let target = boxOf(el);
  for (const { el: c, overflow } of clippers(el)) {
    const area = boxOf(c);
    const next = { ...target };
    for (const axis of AXES) {
      const kind = overflow[axis.start];
      const start = target[axis.start], size = target[axis.size];
      if (SCROLLS.has(kind)) {
        // Scrolled back to its start, where would the element lie? Past this, what must show is the scroll area.
        const fromStart = start + c[axis.scrolled];
        const scrollEnd = area[axis.start] + c[axis.border] + c[axis.extent];
        if (fromStart < area[axis.start] - EDGE || fromStart + size > scrollEnd + EDGE) return false;
        next[axis.start] = area[axis.start];
        next[axis.size] = area[axis.size];
      } else if (CLIPS_HARD.has(kind) && (start < area[axis.start] - EDGE || start + size > area[axis.start] + area[axis.size] + EDGE)) {
        return false;
      }
    }
    target = next;
  }
  return true;
}

/**
 * An element's font size as drawn, in pixels.
 * @param {Element} el
 */
export const fontSize = el => Number.parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).fontSize ?? '0');
