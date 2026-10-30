// @ts-check
// Touch on the phone's terminal: one finger pans the screen and scrolls back through what it printed, and a flick
// glides; two fingers pinch the font; a touch that doesn't move is a tap. The page never scrolls or zooms under it, and
// xterm's own touch handling is kept out (it scrolled nothing on the phone).

/** How far a finger moves before a touch is a drag, not a tap (px). */
const SLOP = 8;
/** The font sizes pinching goes between, in half points. */
const PINCH = Object.freeze({ min: 6, max: 28, step: 2 });
/**
 * A flick keeps going, slowing by friction each frame (of about 16 ms) until it's slower than least (px per ms); not
 * when the finger rested longer than still (ms) before lifting.
 */
const GLIDE = Object.freeze({ friction: 0.95, least: 0.02, frame: 16, still: 100 });
/** The element xterm draws the PC's screen in. */
export const SCREEN = '.xterm-screen';
/** A line's height before xterm has drawn one (px). */
const LINE = 16;
/** Listened to before xterm's own handlers, which are inside the box. */
const FIRST = Object.freeze({ capture: true, passive: false });

/** @param {TouchList} t */
const spread = t => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);

/** @param {any} term */
const lineOf = term => {
  const screen = /** @type {HTMLElement | null} */ (term.element?.querySelector(SCREEN));
  return screen?.offsetHeight ? screen.offsetHeight / term.rows : LINE;
};

/**
 * @param {HTMLElement} box The box xterm is drawn in; it's moved by setting its scroll position.
 * @param {{ term: () => any, size: () => number, resize: (size: number) => void, sized: () => void, tap: () => void }} on
 */
export function terminalTouch(box, on) {
  /** @type {{ x: number, y: number, at: number, vx: number, vy: number, moved: boolean } | null} */
  let drag = null;
  /** @type {{ distance: number, size: number } | null} */
  let pinch = null;
  /** Part of a line dragged but not scrolled yet. */
  let lines = 0;
  let gliding = 0;

  /** @param {any} term @param {number} dy */
  function scrollback(term, dy) {
    lines += dy / lineOf(term);
    const whole = Math.trunc(lines);
    if (whole) term.scrollLines(-whole);
    lines -= whole;
  }

  /** Follows the finger: sideways; down shows the top of the screen, then what scrolled off it; up comes back. */
  function pan(/** @type {number} */ dx, /** @type {number} */ dy) {
    box.scrollLeft -= dx;
    const term = on.term();
    const buffer = term?.buffer.active;
    if (!term) box.scrollTop -= dy;
    else if (dy > 0) {
      const own = Math.min(dy, box.scrollTop);
      box.scrollTop -= own;
      scrollback(term, dy - own);
    } else if (buffer.viewportY < buffer.baseY) scrollback(term, dy);
    else box.scrollTop -= dy;
  }

  function glide(/** @type {number} */ vx, /** @type {number} */ vy) {
    if (Math.hypot(vx, vy) < GLIDE.least) return;
    pan(vx * GLIDE.frame, vy * GLIDE.frame);
    gliding = requestAnimationFrame(() => glide(vx * GLIDE.friction, vy * GLIDE.friction));
  }

  box.addEventListener('touchstart', e => {
    e.stopPropagation();
    cancelAnimationFrame(gliding);
    const [t] = e.touches;
    if (e.touches.length === 2) {
      pinch = { distance: spread(e.touches), size: on.size() };
      drag = null;
    } else if (e.touches.length === 1 && !pinch) drag = { x: t.clientX, y: t.clientY, at: e.timeStamp, vx: 0, vy: 0, moved: false };
  }, FIRST);

  box.addEventListener('touchmove', e => {
    e.stopPropagation();
    e.preventDefault();
    if (pinch && e.touches.length === 2) {
      const size = Math.round(pinch.size * (spread(e.touches) / pinch.distance) * PINCH.step) / PINCH.step;
      on.resize(Math.max(PINCH.min, Math.min(PINCH.max, size)));
      return;
    }
    const [t] = e.touches;
    if (!drag || !t) return;
    const dx = t.clientX - drag.x;
    const dy = t.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < SLOP) return;
    const elapsed = Math.max(e.timeStamp - drag.at, 1);
    drag = { x: t.clientX, y: t.clientY, at: e.timeStamp, vx: dx / elapsed, vy: dy / elapsed, moved: true };
    pan(dx, dy);
  }, FIRST);

  box.addEventListener('touchend', e => {
    e.stopPropagation();
    if (pinch) {
      if (e.touches.length === 0) {
        pinch = null;
        on.sized();
      }
      return;
    }
    if (drag?.moved) {
      if (e.timeStamp - drag.at < GLIDE.still) glide(drag.vx, drag.vy);
    }
    else if (drag) on.tap();
    drag = null;
  }, FIRST);

  // iOS zooms the page on its own gesture events too.
  box.addEventListener('gesturestart', e => e.preventDefault());
}
