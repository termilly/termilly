// @ts-check
// Touch on the phone's terminal: one finger pans the screen and scrolls back through what it printed, and a flick
// glides; two fingers pinch the font; a touch that doesn't move is a tap. Scrolling back is smooth (the screen slides
// by the part of a line not scrolled yet, and settles on a line when it stops) or line by line, as Settings say. The page never scrolls or zooms under it, and
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
/** The touch events a finger sends (manage.js swipes rows with them too). */
export const TOUCH = Object.freeze({ start: 'touchstart', move: 'touchmove', end: 'touchend' });
/** How the terminal scrolls back (Settings › Scrolling), and where the phone keeps it. */
export const SCROLLING = Object.freeze({ key: 'termilly.terminal.scrolling', smooth: 'smooth', lines: 'lines' });
/** How long settling on a line takes (ms). */
const SETTLE_MS = 120;
const smooth = () => localStorage.getItem(SCROLLING.key) !== SCROLLING.lines;
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
    lines -= whole;
    const moved = scrollBy(term, whole);
    // Nothing to slide toward past the oldest line or the newest.
    const buffer = term.buffer.active;
    if ((lines > 0 && buffer.viewportY <= 0) || (lines < 0 && buffer.viewportY >= buffer.baseY)) lines = 0;
    if (!moved) slide(term);
  }

  /** Waiting for xterm to draw lines scrolled to, to slide the screen with them. @type {{ dispose: () => void } | null} */
  let drawing = null;

  /**
   * Scrolls whole lines back or forward; true when that moved the screen. xterm draws the lines a frame later, so the
   * screen slides to its new place when they're drawn, not before: sliding at once showed the old lines a line off for
   * a frame, a flicker when scrolling fast.
   * @param {any} term @param {number} whole @param {() => void} [then] What to do once they're drawn (slide there).
   */
  function scrollBy(term, whole, then = () => slide(term)) {
    if (!whole) return false;
    const before = term.buffer.active.viewportY;
    term.scrollLines(-whole);
    if (term.buffer.active.viewportY === before) return false;
    drawing ??= term.onRender(() => {
      drawing?.dispose();
      drawing = null;
      then();
    });
    return true;
  }

  /** Smooth: the screen sits the part of a line not scrolled yet lower or higher. @param {any} term */
  function slide(term) {
    const screen = /** @type {HTMLElement | null} */ (term?.element?.querySelector(SCREEN));
    if (screen) screen.style.transform = smooth() && lines ? `translateY(${(lines * lineOf(term)).toFixed(1)}px)` : '';
  }

  /** The scrolling stopped: smooth settles on the nearest line, easing there rather than jumping. */
  function settle() {
    const term = on.term();
    if (!term || !smooth()) return;
    const whole = Math.round(lines);
    lines -= whole; // what's left once on that line: the screen starts there, then eases to none
    if (!scrollBy(term, whole, () => ease(term))) ease(term);
  }

  /** @param {any} term */
  function ease(term) {
    slide(term);
    const screen = /** @type {HTMLElement | null} */ (term.element?.querySelector(SCREEN));
    if (!screen) return;
    requestAnimationFrame(() => {
      screen.style.transition = `transform ${SETTLE_MS}ms ease-out`;
      lines = 0;
      slide(term);
      setTimeout(() => { screen.style.transition = ''; }, SETTLE_MS);
    });
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
    if (Math.hypot(vx, vy) < GLIDE.least) {
      settle();
      return;
    }
    pan(vx * GLIDE.frame, vy * GLIDE.frame);
    gliding = requestAnimationFrame(() => glide(vx * GLIDE.friction, vy * GLIDE.friction));
  }

  box.addEventListener(TOUCH.start, e => {
    e.stopPropagation();
    cancelAnimationFrame(gliding);
    const screen = /** @type {HTMLElement | null} */ (on.term()?.element?.querySelector(SCREEN));
    if (screen) screen.style.transition = ''; // a finger takes over from easing at once
    const [t] = e.touches;
    if (e.touches.length === 2) {
      pinch = { distance: spread(e.touches), size: on.size() };
      drag = null;
    } else if (e.touches.length === 1 && !pinch) drag = { x: t.clientX, y: t.clientY, at: e.timeStamp, vx: 0, vy: 0, moved: false };
  }, FIRST);

  box.addEventListener(TOUCH.move, e => {
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

  box.addEventListener(TOUCH.end, e => {
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
      else settle();
    }
    else if (drag) on.tap();
    drag = null;
  }, FIRST);

  // iOS zooms the page on its own gesture events too.
  box.addEventListener('gesturestart', e => e.preventDefault());
}
