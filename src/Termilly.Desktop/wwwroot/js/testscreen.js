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

/** The ancestors that clip an element, nearest first, with how. @param {Element} el */
function clippers(el) {
  /** @type {{ el: Element, scrolls: boolean }[]} */
  const found = [];
  for (let at = el.parentElement; at; at = at.parentElement) {
    const style = at.ownerDocument.defaultView?.getComputedStyle(at);
    const overflow = [style?.overflowX ?? '', style?.overflowY ?? ''];
    if (overflow.some(o => CLIPS_HARD.has(o) || SCROLLS.has(o))) found.push({ el: at, scrolls: overflow.some(o => SCROLLS.has(o)) });
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
 * Whether all of an element can be seen, scrolling where its ancestors scroll: nothing cut off by an ancestor that
 * doesn't scroll, and nothing before a scrolling one's start (above or left of it), where no scrolling reaches.
 * @param {Element} el
 */
export function reachable(el) {
  let target = boxOf(el);
  for (const { el: c, scrolls } of clippers(el)) {
    const area = boxOf(c);
    if (scrolls) {
      // Scrolled back to its start, where would the element begin? Past this, what must show is the scroll area.
      if (target.x + c.scrollLeft < area.x - EDGE || target.y + c.scrollTop < area.y - EDGE) return false;
      target = area;
    } else if (!within(target, area)) {
      return false;
    }
  }
  return true;
}

/**
 * An element's font size as drawn, in pixels.
 * @param {Element} el
 */
export const fontSize = el => Number.parseFloat(el.ownerDocument.defaultView?.getComputedStyle(el).fontSize ?? '0');
